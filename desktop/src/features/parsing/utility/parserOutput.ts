import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { prepareReaderMarkdown, isLocalMarkdownImage } from '@platform/markdown/core/standardMarkdown'
import { dirname, extname, isAbsolute, join, relative } from 'node:path'
import type { BlockMapping } from '../contract/blocks'
import type { CopilotixTask } from '@features/library/contract/documentTypes'
import { alignMarkdownBlocks } from '../core/markdownBlocks'
import { displayPaperTitle, extractPaperTitle } from '@features/library/core'
import { BLOCK_MAPPING_VERSION, buildBlockMappings } from '../core/blockMapping'
import { applyTextLayerRepairs, findTextLayerCandidates, planTextLayerRepairs, TEXT_LAYER_REPAIR_VERSION, type TextLayerRepairReport } from '../core/textLayerRepair'
import { readPdfTextLayer } from './pdfTextLayer'
import { CoreUtilityOperationError } from '@platform/rpc/utility/coreUtilityRuntime'
import { V2TaskRepositoryCompat } from '@features/library/utility'
import { PathPolicy } from '@platform/files/runtime/pathPolicy'
import { hashFile, isNotFound } from '@platform/files/utility/fileHash'

/** Utility side of parsing: publish parser output, rebuild block mappings and repair fragmented lines from the PDF text layer. */
export async function normalizeParserOutput(
  task: CopilotixTask,
  extractedDir: string,
  repository: V2TaskRepositoryCompat,
  jobId?: string,
  signal?: AbortSignal
): Promise<{ normalized: true; displayTitle: string | null; pageCount: number }> {
  assertTaskPath(task.outputDir)
  assertTaskPath(extractedDir)
  await mkdir(task.outputDir, { recursive: true })
  const pathPolicy = new PathPolicy()
  const extractedRoot = pathPolicy.resolveChild(task.outputDir, extractedDir)
  const files = await walkFiles(extractedRoot, pathPolicy)
  const markdown = files.find((path) => extname(path).toLowerCase() === '.md')
  const layout = files.find((path) => /(?:layout|middle)\.json$/iu.test(path))
  const contentList = files.find((path) => /content_list(?:_v2)?\.json$/iu.test(path))
  if (!markdown || !layout) throw new CoreUtilityOperationError('CORE_UNAVAILABLE', 'Copilotix result is incomplete', false)

  const suffix = jobId && /^[A-Za-z0-9._-]+$/u.test(jobId) ? jobId : 'legacy'
  const stagingRoot = pathPolicy.resolveChild(task.outputDir, `.normalize.partial-${suffix}`)
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true })
  const staged = async (source: string, targetRelativePath: string): Promise<string> => {
    const target = pathPolicy.resolveChild(stagingRoot, targetRelativePath)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    return target
  }
  const revisions: Array<{ taskId: string; kind: Parameters<V2TaskRepositoryCompat['recordArtifactRevision']>[1]; path: string; checksum: string; jobId?: string }> = []
  const imageFiles: Array<{ stagedPath: string; relativePath: string }> = []
  try {
    const markdownStaged = await staged(markdown, 'full.md')
    const layoutStaged = await staged(layout, 'layout.json')
    const artifactSources: Array<{ kind: Parameters<V2TaskRepositoryCompat['recordArtifactRevision']>[1]; relativePath: string; stagedPath: string }> = [
      { kind: 'parsed_markdown', relativePath: 'full.md', stagedPath: markdownStaged },
      { kind: 'layout', relativePath: 'layout.json', stagedPath: layoutStaged }
    ]
    if (contentList) artifactSources.push({ kind: 'content_list', relativePath: 'content_list.json', stagedPath: await staged(contentList, 'content_list.json') })

    for (const file of files) {
      const rel = relative(extractedRoot, file)
      if (!/[/\\]images?[/\\]/iu.test(file) && !/\.(png|jpe?g|webp|gif|svg)$/iu.test(file)) continue
      imageFiles.push({ stagedPath: await staged(file, rel), relativePath: rel })
    }

    let layoutData = JSON.parse(await readFile(layoutStaged, 'utf8')) as unknown
    // Before Markdown preparation, so repaired spans match the parser's own text.
    const repaired = await repairFromTextLayer(layoutData, await readFile(markdownStaged, 'utf8'), pathPolicy.resolveChild(task.outputDir, 'original.pdf'), signal)
    let reportStaged: string | null = null
    if (repaired) {
      layoutData = repaired.layout
      if (repaired.report.repairs.length > 0) {
        await writeFile(layoutStaged, JSON.stringify(repaired.layout), 'utf8')
        await writeFile(markdownStaged, repaired.markdown, 'utf8')
      }
      reportStaged = pathPolicy.resolveChild(stagingRoot, TEXT_LAYER_REPORT)
      await writeFile(reportStaged, JSON.stringify(repaired.report, null, 2), 'utf8')
    }
    const mappings = buildBlockMappings(task.id, layoutData)
    const pageCount = mappings.reduce((maximum, mapping) => Math.max(maximum, ...mapping.boxes.map((box) => box.pageIndex + 1), 0), 0)
    const markdownText = prepareReaderMarkdown(await readFile(markdownStaged, 'utf8'), (url) => {
      if (!isLocalMarkdownImage(url)) return url
      const asset = pathPolicy.resolveChild(extractedRoot, join(dirname(markdown), decodeURIComponent(url.split(/[?#]/u)[0]!)))
      return relative(extractedRoot, asset).replace(/\\/gu, '/').split('/').map(encodeURIComponent).join('/')
    })
    await writeFile(markdownStaged, markdownText, 'utf8')
    const extractedTitle = extractPaperTitle(markdownText, mappings)
    const displayTitle = extractedTitle ? displayPaperTitle(extractedTitle) : null
    const blockStaged = pathPolicy.resolveChild(stagingRoot, 'block_list.json')
    await writeFile(blockStaged, JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings }, null, 2), 'utf8')
    artifactSources.push({ kind: 'block_mappings', relativePath: 'block_list.json', stagedPath: blockStaged })

    for (const artifact of artifactSources) {
      const destination = pathPolicy.resolveChild(task.outputDir, artifact.relativePath)
      const checksum = await hashFile(artifact.stagedPath)
      await publishStagedFile(artifact.stagedPath, destination, checksum)
      revisions.push({ taskId: task.id, kind: artifact.kind, path: destination, checksum, jobId })
    }
    for (const image of imageFiles) {
      const destination = pathPolicy.resolveChild(task.outputDir, image.relativePath)
      await publishStagedFile(image.stagedPath, destination, await hashFile(image.stagedPath))
    }
    if (reportStaged) await publishStagedFile(reportStaged, pathPolicy.resolveChild(task.outputDir, TEXT_LAYER_REPORT), await hashFile(reportStaged))
    repository.recordArtifactRevisions(revisions)
    return { normalized: true, displayTitle, pageCount }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Provenance of text-layer repairs; not an artifact revision, readers never depend on it. */
const TEXT_LAYER_REPORT = 'text-layer-repair.json'

/**
 * Replace fragmented parser lines with the PDF text layer. Returns null when
 * the layout has no fragmented lines. A PDF that cannot be read leaves every
 * candidate unresolved instead of failing the parse.
 */
async function repairFromTextLayer(layout: unknown, markdown: string, pdfPath: string, signal?: AbortSignal, protectedBlocks: readonly string[] = []): Promise<{ layout: unknown; markdown: string; report: TextLayerRepairReport } | null> {
  const candidates = findTextLayerCandidates(layout)
  if (candidates.length === 0) return null
  try {
    const pages = [...new Map(candidates.map((candidate) => [candidate.pageIndex, { pageIndex: candidate.pageIndex, pageSize: candidate.pageSize }])).values()]
    const layer = await readPdfTextLayer(pdfPath, pages, signal)
    let result = applyTextLayerRepairs(layout, markdown, planTextLayerRepairs(candidates, layer), protectedBlocks)
    // A repaired span can make its neighbour locatable in the Markdown; settle here
    // instead of publishing (and re-preparing the reader) once per pass.
    for (let pass = 0; pass < 3 && result.report.repairs.length > 0; pass += 1) {
      const next = applyTextLayerRepairs(result.layout, result.markdown, planTextLayerRepairs(findTextLayerCandidates(result.layout), layer), protectedBlocks)
      if (next.report.repairs.length === 0) break
      result = { ...next, report: { ...next.report, repairs: [...result.report.repairs, ...next.report.repairs] } }
    }
    return result
  } catch (error) {
    if (signal?.aborted) throw error
    return { layout, markdown, report: { version: TEXT_LAYER_REPAIR_VERSION, repairs: [], unresolved: candidates } }
  }
}

/**
 * Parsed Markdown of blocks the user edited or deleted in the reader
 * (`edits/markdown-edits.v1.json`). The user's text always wins, so the repair
 * leaves these blocks alone. Each entry is located like the reader does: its
 * recorded position when mappings or base hash still match, else the one block
 * with the same mappings, else the one with the same base hash. Null when the
 * file exists but cannot be read.
 */
async function userEditedBlocks(outputDir: string, documentId: string, markdown: string): Promise<string[] | null> {
  const pathPolicy = new PathPolicy()
  let raw: string
  try {
    raw = await readFile(pathPolicy.resolveChild(outputDir, 'edits/markdown-edits.v1.json'), 'utf8')
  } catch (error) {
    return isNotFound(error) ? [] : null
  }
  try {
    const file = JSON.parse(raw) as { version?: unknown; documentId?: unknown; blocks?: unknown }
    if (file.version !== 1 || file.documentId !== documentId || !Array.isArray(file.blocks)) return null
    const mappings = (JSON.parse(await readFile(pathPolicy.resolveChild(outputDir, 'block_list.json'), 'utf8')) as { mappings?: unknown }).mappings
    const blocks = alignMarkdownBlocks(markdown, Array.isArray(mappings) ? mappings as BlockMapping[] : [])
    const hashes = blocks.map((block) => createHash('sha256').update(block.markdown).digest('hex'))
    const sameIds = (left: readonly string[], right: readonly string[]): boolean => left.length > 0 && [...left].sort().join('\u0000') === [...right].sort().join('\u0000')
    const result: string[] = []
    for (const entry of file.blocks as Array<{ index?: number; mappingIds?: string[]; baseHash?: string; original?: unknown; deletedAt?: unknown }>) {
      if (!entry.original && !entry.deletedAt) continue
      const ids = Array.isArray(entry.mappingIds) ? entry.mappingIds : []
      const at = typeof entry.index === 'number' ? blocks[entry.index] : undefined
      const unique = (matches: number[]): number | undefined => matches.length === 1 ? matches[0] : undefined
      const found = at && (sameIds(at.mappingIds, ids) || hashes[entry.index!] === entry.baseHash) ? entry.index!
        : unique(blocks.flatMap((block, index) => sameIds(block.mappingIds, ids) ? [index] : []))
          ?? unique(hashes.flatMap((hash, index) => hash === entry.baseHash ? [index] : []))
      // An edit that cannot be placed protects nothing here, as in the reader (orphan).
      if (found !== undefined) result.push(blocks[found]!.markdown)
    }
    return result
  } catch {
    return null
  }
}

/**
 * Repair an already published parse in place (user-initiated; old papers are
 * never re-parsed automatically). Markdown is published first and the layout
 * last, so an interrupted run is completed by the next one.
 */
export async function repairParsedTextLayer(taskId: string, repository: V2TaskRepositoryCompat, signal?: AbortSignal): Promise<{ repaired: number; unresolved: number }> {
  const task = repository.getTask(taskId)
  if (!task) throw new CoreUtilityOperationError('CORE_NOT_FOUND', 'Document not found', false)
  assertTaskPath(task.outputDir)
  const pathPolicy = new PathPolicy()
  const path = (name: string): string => pathPolicy.resolveChild(task.outputDir, name)
  const layout = JSON.parse(await readFile(path('layout.json'), 'utf8')) as unknown
  const markdown = await readFile(path('full.md'), 'utf8')
  const protectedBlocks = await userEditedBlocks(task.outputDir, taskId, markdown)
  // An edits file that cannot be read must not be overruled: leave the paper as it is.
  if (protectedBlocks === null) return { repaired: 0, unresolved: 0 }
  const repaired = await repairFromTextLayer(layout, markdown, path('original.pdf'), signal, protectedBlocks)
  if (!repaired || repaired.report.repairs.length === 0) return { repaired: 0, unresolved: repaired?.report.unresolved.length ?? 0 }
  signal?.throwIfAborted()
  const stagingRoot = path(`.text-layer-repair.partial-${randomUUID()}`)
  await mkdir(stagingRoot, { recursive: true })
  try {
    let previous: TextLayerRepairReport['repairs'] = []
    try {
      const existing = JSON.parse(await readFile(path(TEXT_LAYER_REPORT), 'utf8')) as Partial<TextLayerRepairReport>
      if (existing.version === TEXT_LAYER_REPAIR_VERSION && Array.isArray(existing.repairs)) previous = existing.repairs
    } catch {
      // No earlier report.
    }
    const files: Array<{ kind: 'parsed_markdown' | 'layout' | 'block_mappings' | null; name: string; content: string }> = [
      { kind: 'parsed_markdown', name: 'full.md', content: repaired.markdown },
      { kind: 'block_mappings', name: 'block_list.json', content: JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings: buildBlockMappings(taskId, repaired.layout) }, null, 2) },
      { kind: 'layout', name: 'layout.json', content: JSON.stringify(repaired.layout) },
      { kind: null, name: TEXT_LAYER_REPORT, content: JSON.stringify({ ...repaired.report, repairs: [...previous, ...repaired.report.repairs] }, null, 2) }
    ]
    const revisions: Array<{ kind: 'parsed_markdown' | 'layout' | 'block_mappings'; path: string; checksum: string }> = []
    for (const file of files) {
      const staged = pathPolicy.resolveChild(stagingRoot, file.name)
      await writeFile(staged, file.content, 'utf8')
      const checksum = await hashFile(staged)
      await publishStagedFile(staged, path(file.name), checksum)
      if (file.kind) revisions.push({ kind: file.kind, path: path(file.name), checksum })
    }
    repository.recordTextLayerRepair(taskId, revisions, { textLayerRepair: TEXT_LAYER_REPAIR_VERSION, repairs: repaired.report.repairs.length })
    return { repaired: repaired.report.repairs.length, unresolved: repaired.report.unresolved.length }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function rebuildMappings(taskId: string, outputDir: string, repository: V2TaskRepositoryCompat): Promise<void> {
  assertTaskPath(outputDir)
  const layoutPath = join(outputDir, 'layout.json')
  const blockPath = join(outputDir, 'block_list.json')
  const mappings = buildBlockMappings(taskId, JSON.parse(await readFile(layoutPath, 'utf8')) as unknown)
  const stagedPath = join(outputDir, `.block_list.partial-${randomUUID()}.json`)
  try {
    await writeFile(stagedPath, JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings }, null, 2), 'utf8')
    const checksum = await hashFile(stagedPath)
    await publishStagedFile(stagedPath, blockPath, checksum)
    const task = repository.getTask(taskId)
    if (task) repository.recordArtifactRevision(taskId, 'block_mappings', blockPath, checksum)
  } finally {
    await rm(stagedPath, { force: true }).catch(() => undefined)
  }
}

export async function publishStagedFile(stagedPath: string, destination: string, checksum: string): Promise<void> {
  try {
    const existing = await lstat(destination)
    if (!existing.isFile()) throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Artifact destination is not a regular file', false)
    if (await hashFile(destination) === checksum) {
      await rm(stagedPath, { force: true })
      return
    }
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  await mkdir(dirname(destination), { recursive: true })
  await syncFile(stagedPath)
  await rename(stagedPath, destination)
}

export async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function walkFiles(root: string, pathPolicy: PathPolicy): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    pathPolicy.resolveChild(root, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Artifact staging contains a symbolic link', false)
    if (info.isDirectory()) result.push(...await walkFiles(path, pathPolicy))
    else if (info.isFile()) result.push(path)
    else throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Artifact staging contains an unsupported file', false)
  }
  return result
}

export function assertTaskPath(path: string): void {
  if (!isAbsolute(path) || path.length > 32_768 || path.includes('\0')) throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Invalid utility path', false)
}
