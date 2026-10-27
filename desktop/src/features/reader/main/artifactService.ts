import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import archiver from 'archiver'
import type { BlockMapping } from '@features/parsing/contract/blocks'
import type { DocumentPayload, CopilotixTask } from '@features/library/contract/documentTypes'
import type { TranslatedMarkdownBlock, TranslationProviderId } from '@features/translation/contract/translationTypes'
import { TRANSLATION_PROVIDER_IDS } from '@features/translation/contract/providerPolicy'
import { TABLE_TRANSLATION_PROTOCOL, TRANSLATION_PIPELINE_VERSION, LEGACY_TRANSLATION_PIPELINE_VERSION, STANDARD_TRANSLATION_PIPELINE_VERSION } from '@features/translation/contract/translationPlanProtocol'
import { normalizeMarkdown, isLocalMarkdownImage } from '@platform/markdown/core/standardMarkdown'
import type { PathPolicyPort } from '@platform/files/contract/pathPolicyPort'
import type { TaskComputePort } from '@features/library/contract/taskCompute'
import { BLOCK_MAPPING_VERSION, MARKDOWN_MAPPING_ALGORITHM_VERSION, alignMarkdownBlocks } from '@features/parsing/core'
import { type EditableBlock, editExcerpt, effectiveOriginalBlocks, inReadingOrder, joinVisibleBlocks, resolveMarkdownEdits, validOrder, type MarkdownEditsFile, type ResolvedMarkdownEdits } from '../contract/markdownEdits'
import { readerContentMappings } from '../core/readerDocument'
import { readMarkdownEditsFile } from '../runtime/markdownEditsFile'
import { buildReaderFigureGeometries } from '../core/readerFigureGroups'
import { projectFigureMarkdown, type FigureArtifact } from '../core/figureArtifacts'
import type { CacheDocumentFigureRequest, CacheDocumentFigureResult } from '../contract/readerSchemas'
import { figureGeometryKey, figureSourceRevision, readFigureArtifacts, storeFigureArtifact, writeDerivedFile } from './figureArtifactStore'
import type { TaskRepositoryCompat } from '@features/library/contract/taskRepository'

/** Filesystem-facing document/artifact operations kept out of command and runner orchestration. */
export class ArtifactService {
  private readonly figureWrites = new Map<string, Promise<CacheDocumentFigureResult>>()
  private readonly blockedFigureWrites = new Set<string>()
  constructor(
    private readonly repository: TaskRepositoryCompat,
    private readonly compute: TaskComputePort,
    private readonly pathPolicy: PathPolicyPort
  ) {}

  async getDocument(taskId: string): Promise<DocumentPayload> {
    const task = await this.requireTask(taskId)
    // Long papers produce multi-megabyte artifacts; read them concurrently.
    const [markdown, translatedBlocks, storedTranslatedMarkdown, layoutJson, mappings, edits] = await Promise.all([
      this.readOptional(join(task.outputDir, 'full.md')),
      this.loadTranslatedBlocks(task),
      this.readOptional(join(task.outputDir, 'full.zh-CN.md')),
      this.readOptional(join(task.outputDir, 'layout.json'), '{}'),
      this.loadMappings(task),
      // An unreadable edit file must not block reading; saving then reports it.
      readMarkdownEditsFile(task.outputDir, task.id).catch(() => null)
    ])
    // A succeeded translation job can outlive a missing/stale convenience
    // projection. The manifest is task-bound and contains the durable ordered
    // blocks, so prefer it when available instead of silently rendering blank
    // (or content left by another projection) in the reader.
    const translatedMarkdown = translatedBlocks && translatedBlocks.length > 0
      ? joinTranslatedMarkdownBlocks(translatedBlocks)
      : storedTranslatedMarkdown
    return {
      task,
      markdown,
      translatedMarkdown,
      translatedBlocks,
      layoutJson,
      mappings,
      markdownEdits: edits ? resolveReaderEdits(markdown, mappings, translatedBlocks, edits, edits.blocks.length || edits.order ? this.aligned(task.id, markdown, mappings) : undefined) : null,
      pdfUrl: `copilotix-asset://${task.id}/original.pdf`,
      assetBaseUrl: `copilotix-asset://${task.id}/`
    }
  }

  async resolveAsset(taskId: string, assetPath: string): Promise<string> {
    const task = await this.requireTask(taskId)
    return this.pathPolicy.resolveChild(task.outputDir, decodeURIComponent(assetPath.replace(/^\/+/, '')))
  }

  /** Main resolves paths and recomputes complete geometry; Renderer supplies only bounded PNG data. */
  async cacheFigure(request: CacheDocumentFigureRequest): Promise<CacheDocumentFigureResult> {
    if (this.blockedFigureWrites.has(request.documentId)) throw new Error('文献正在删除')
    const pending = (this.figureWrites.get(request.documentId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const document = await this.getDocument(request.documentId)
      const task = document.task
      const geometries = buildReaderFigureGeometries(document.mappings, document.layoutJson)
      const geometry = geometries.find(g => g.id === request.figureId && g.status === 'complete')
      if (!geometry || figureGeometryKey(geometry) !== request.geometryKey) throw new Error('整图来源已变化或归属不确定')
      const revision = await figureSourceRevision(task.outputDir, task.sourceHash, document.layoutJson)
      const previous = await readFigureArtifacts(task.outputDir, revision, geometries)
      let artifact = previous.find(f => f.figureId === geometry.id)
      if (request.pngBase64) {
        if (request.sourceRevision !== revision) throw new Error('文献已更新，请重新生成整图')
        artifact = await storeFigureArtifact(task.outputDir, revision, geometry, request.pngBase64, previous)
      }
      if (artifact) {
        const saved = artifact
        const figures = [...previous.filter(f => f.figureId !== saved.figureId), saved]
        await this.publishFigureMarkdown(task, document.markdown, document.translatedMarkdown, figures)
      }
      return { imagePath: artifact?.imagePath ?? null, sourceRevision: revision }
    })
    this.figureWrites.set(request.documentId, pending)
    try { return await pending } finally {
      if (this.figureWrites.get(request.documentId) === pending) this.figureWrites.delete(request.documentId)
    }
  }

  async freezeFigureWrites(documentId: string): Promise<void> {
    this.blockedFigureWrites.add(documentId)
    await this.figureWrites.get(documentId)?.catch(() => undefined)
  }
  resumeFigureWrites(documentId: string): void { this.blockedFigureWrites.delete(documentId) }

  /** Re-project the derived figure Markdown after the source text changed. */
  async refreshFigureMarkdown(taskId: string): Promise<void> {
    const document = await this.getDocument(taskId)
    const revision = await figureSourceRevision(document.task.outputDir, document.task.sourceHash, document.layoutJson)
    const figures = await readFigureArtifacts(document.task.outputDir, revision, buildReaderFigureGeometries(document.mappings, document.layoutJson))
    await this.publishFigureMarkdown(document.task, document.markdown, document.translatedMarkdown, figures)
  }

  private async publishFigureMarkdown(task: CopilotixTask, original: string, translated: string, figures: readonly FigureArtifact[]): Promise<void> {
    for (const [name, source] of [['full.figures.md', original], ['full.zh-CN.figures.md', translated]] as const) {
      if (!source) continue
      const projected = projectFigureMarkdown(source, figures)
      const path = join(task.outputDir, name)
      if (await this.readOptional(path) !== projected) await writeDerivedFile(path, projected)
    }
  }

  private async figureProjection(task: CopilotixTask, markdown: string): Promise<string> {
    try {
      const layout = await this.readOptional(join(task.outputDir, 'layout.json'), '{}')
      const mappings = await this.loadMappings(task)
      const geometries = buildReaderFigureGeometries(mappings, layout)
      const revision = await figureSourceRevision(task.outputDir, task.sourceHash, layout)
      return projectFigureMarkdown(markdown, await readFigureArtifacts(task.outputDir, revision, geometries))
    } catch { return markdown }
  }

  async createResultZip(taskId: string, destination: string): Promise<void> {
    const task = await this.requireTask(taskId)
    await this.assertExportDestination(task, destination)
    const texts = await this.editedTexts(task)
    const original = await this.figureProjection(task, texts.original)
    const translated = await this.figureProjection(task, texts.translated)
    const images = new Set<string>()
    const normalize = (markdown: string): string => normalizeMarkdown(markdown, (url) => {
      if (!isLocalMarkdownImage(url)) return url
      const path = this.pathPolicy.resolveChild(task.outputDir, decodeURIComponent(url.split(/[?#]/u)[0]!).replace(/^\/+/, ''))
      images.add(path)
      return relative(task.outputDir, path).split(/[\\/]/u).map(encodeURIComponent).join('/')
    }).markdown
    // Validate everything before opening an archive stream; a formatting error
    // must not leave an unfinished stream or overwrite the previous export.
    const normalizedOriginal = original ? normalize(original) : ''
    const normalizedTranslated = translated ? normalize(translated) : ''
    await Promise.all([...images].map(async (path) => {
      if (!(await lstat(path)).isFile()) throw new Error(`图片资源不是普通文件：${basename(path)}`)
    }))
    const partial = `${destination}.partial-${randomUUID()}`
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const output = createWriteStream(partial, { flags: 'wx' })
        const archive = archiver('zip', { zlib: { level: 9 } })
        let failure: Error | undefined
        output.on('close', () => failure ? reject(failure) : resolvePromise())
        const fail = (error: Error): void => { failure ??= error; archive.abort(); output.destroy() }
        output.on('error', fail)
        archive.on('error', fail)
        archive.on('warning', fail)
        archive.pipe(output)
        archive.directory(task.outputDir, false, (entry) => shouldIncludeResultZipEntry(entry.name) &&
          !['full.md', 'full.zh-CN.md'].includes(entry.name) ? entry : false)
        if (normalizedOriginal) archive.append(normalizedOriginal, { name: 'full.md' })
        if (normalizedTranslated) archive.append(normalizedTranslated, { name: 'full.zh-CN.md' })
        void archive.finalize().catch(fail)
      })
      await rename(partial, destination)
    } finally {
      await rm(partial, { force: true }).catch(() => undefined)
    }
  }

  /** Publish Markdown last, after all referenced local resources have been copied. */
  async exportMarkdown(taskId: string, kind: 'original-markdown' | 'translated-markdown', destination: string): Promise<void> {
    const task = await this.requireTask(taskId)
    await this.assertExportDestination(task, destination)
    const texts = await this.editedTexts(task)
    const source = kind === 'original-markdown' ? texts.original : texts.translated
    if (!source) throw new Error('没有可导出的 Markdown')
    const folder = `${basename(destination, extname(destination))}.assets-${randomUUID()}`
    const assetDir = join(dirname(destination), folder)
    const partialAssets = `${assetDir}.partial`
    const assets = new Map<string, string>()
    const normalized = normalizeMarkdown(await this.figureProjection(task, source), (url) => {
      if (!isLocalMarkdownImage(url)) return url
      const path = this.pathPolicy.resolveChild(task.outputDir, decodeURIComponent(url.split(/[?#]/u)[0]!).replace(/^\/+/, ''))
      let name = assets.get(path)
      if (!name) { name = `${assets.size + 1}-${basename(path)}`; assets.set(path, name) }
      return `${encodeURIComponent(folder)}/${encodeURIComponent(name)}`
    }).markdown
    let publishedAssets = false
    try {
      if (assets.size) {
        await mkdir(partialAssets)
        const copies = await Promise.allSettled([...assets].map(async ([sourcePath, name]) => {
          if (!(await lstat(sourcePath)).isFile()) throw new Error(`图片资源不是普通文件：${basename(sourcePath)}`)
          await copyFile(sourcePath, join(partialAssets, name))
        }))
        const failed = copies.find((result) => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
        await rename(partialAssets, assetDir)
        publishedAssets = true
      }
      await this.atomicWriteFile(destination, normalized)
    } catch (error) {
      if (publishedAssets) await rm(assetDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    } finally {
      await rm(partialAssets, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async assertExportDestination(task: CopilotixTask, destination: string): Promise<void> {
    const taskRoot = await realpath(task.outputDir)
    const target = resolve(await realpath(dirname(destination)), basename(destination))
    const fromTask = relative(taskRoot, target)
    if (!fromTask || (fromTask !== '..' && !fromTask.startsWith(`..${sep}`) && !isAbsolute(fromTask))) throw new Error('请将导出文件保存到文档库以外，避免覆盖原始数据')
    try {
      const info = await lstat(destination)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('导出目标必须是普通文件')
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }

  async atomicWriteFile(path: string, content: string): Promise<void> {
    const partialPath = `${path}.partial-${randomUUID()}`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(partialPath, content, 'utf8')
      const handle = await open(partialPath, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(partialPath, path)
    } finally {
      await rm(partialPath, { force: true }).catch(() => undefined)
    }
  }

  async loadMappings(task: CopilotixTask): Promise<BlockMapping[]> {
    const blockPath = join(task.outputDir, 'block_list.json')
    try {
      const value = JSON.parse(await readFile(blockPath, 'utf8')) as { version?: number; mappings?: BlockMapping[] }
      if (value.version === BLOCK_MAPPING_VERSION && Array.isArray(value.mappings)) return value.mappings
      await this.compute.rebuildMappings(task.id, task.outputDir)
      return readMappings(blockPath)
    } catch {
      try {
        await this.compute.rebuildMappings(task.id, task.outputDir)
        return readMappings(blockPath)
      } catch {
        return []
      }
    }
  }

  async loadTranslatedBlocks(task: CopilotixTask): Promise<TranslatedMarkdownBlock[] | null> {
    try {
      const manifest = JSON.parse(await readFile(join(task.outputDir, 'translation.manifest.json'), 'utf8')) as unknown
      if (!isRecord(manifest) || manifest.version !== 2 || manifest.taskId !== task.id ||
        ![TRANSLATION_PIPELINE_VERSION, LEGACY_TRANSLATION_PIPELINE_VERSION, STANDARD_TRANSLATION_PIPELINE_VERSION].includes(manifest.translationPipelineVersion as typeof TRANSLATION_PIPELINE_VERSION) ||
        manifest.tableTranslationProtocol !== TABLE_TRANSLATION_PROTOCOL ||
        !Array.isArray(manifest.blocks)) return null
      const changed = await this.changedSourceIndexes(task, manifest.blocks)
      const blocks = manifest.blocks.map((block) => {
        if (!isRecord(block) || !Number.isInteger(block.sourceIndex) || (block.sourceIndex as number) < 0 || typeof block.markdown !== 'string') return null
        const mappingIds = Array.isArray(block.mappingIds) && block.mappingIds.every((id) => typeof id === 'string')
          ? [...block.mappingIds] as string[]
          : null
        // Older manifests may lack provider fields; those blocks simply carry no fallback mark.
        const fallbackProvider = block.status === 'completed' && isTranslationProvider(block.provider) &&
          isTranslationProvider(manifest.preferredProvider) && block.provider !== manifest.preferredProvider ? block.provider : undefined
        const sourceHash = typeof block.sourceHash === 'string' && /^[a-f0-9]{64}$/u.test(block.sourceHash) ? block.sourceHash : undefined
        const sourceChanged = changed.has(block.sourceIndex as number) ? true as const : undefined
        return { sourceIndex: block.sourceIndex as number, markdown: block.markdown, mappingIds, fallbackProvider, sourceHash, sourceChanged }
      })
      if (blocks.some((block) => block === null)) return null
      const validBlocks = blocks as Array<{ sourceIndex: number; markdown: string; mappingIds: string[] | null; fallbackProvider?: TranslationProviderId; sourceHash?: string; sourceChanged?: true }>
      const sourceIndexes = validBlocks.map((block) => block.sourceIndex)
      const validSourceOrder = new Set(sourceIndexes).size === sourceIndexes.length &&
        [...sourceIndexes].sort((left, right) => left - right).every((sourceIndex, index) => sourceIndex === index)
      const ordered = validSourceOrder
        ? [...validBlocks].sort((left, right) => left.sourceIndex - right.sourceIndex)
        : validBlocks
      const trustMappings = validSourceOrder && manifest.mappingAlgorithmVersion === MARKDOWN_MAPPING_ALGORITHM_VERSION &&
        manifest.blockMappingVersion === BLOCK_MAPPING_VERSION &&
        ordered.every((block) => Array.isArray(block.mappingIds))
      return ordered.map(({ sourceIndex, markdown, mappingIds, fallbackProvider, sourceHash, sourceChanged }) => ({
        sourceIndex,
        markdown,
        mappingIds: trustMappings ? mappingIds ?? [] : [],
        ...(fallbackProvider ? { fallbackProvider } : {}),
        ...(sourceHash ? { sourceHash } : {}),
        ...(sourceChanged ? { sourceChanged } : {})
      }))
    } catch {
      return null
    }
  }

  /** The edit layer after a change, without sending the paper's text again. */
  async resolvedEdits(taskId: string): Promise<ResolvedMarkdownEdits> {
    const task = await this.requireTask(taskId)
    const [markdown, translatedBlocks, mappings, edits] = await Promise.all([
      this.readOptional(join(task.outputDir, 'full.md')), this.loadTranslatedBlocks(task), this.loadMappings(task),
      readMarkdownEditsFile(task.outputDir, task.id)
    ])
    return resolveReaderEdits(markdown, mappings, translatedBlocks, edits, edits.blocks.length || edits.order ? this.aligned(task.id, markdown, mappings) : undefined)
  }

  /** Content alignment of the paper's current text; recomputed only when the text or mappings change. */
  private readonly alignments = new Map<string, { markdown: string; mappings: number; blocks: ReturnType<typeof alignMarkdownBlocks> }>()
  private aligned(taskId: string, markdown: string, mappings: BlockMapping[]): ReturnType<typeof alignMarkdownBlocks> {
    const cached = this.alignments.get(taskId)
    if (cached && cached.markdown === markdown && cached.mappings === mappings.length) return cached.blocks
    const blocks = alignMarkdownBlocks(markdown, readerContentMappings(mappings))
    this.alignments.delete(taskId)
    this.alignments.set(taskId, { markdown, mappings: mappings.length, blocks })
    if (this.alignments.size > 8) this.alignments.delete(this.alignments.keys().next().value!)
    return blocks
  }

  /** What the reader shows: the user's edits applied and deleted blocks left out. */
  private async editedTexts(task: CopilotixTask): Promise<{ original: string; translated: string }> {
    const [markdown, blocks, storedTranslated, mappings] = await Promise.all([
      this.readOptional(join(task.outputDir, 'full.md')), this.loadTranslatedBlocks(task),
      this.readOptional(join(task.outputDir, 'full.zh-CN.md')), this.loadMappings(task)
    ])
    const translated = blocks?.length ? joinTranslatedMarkdownBlocks(blocks) : storedTranslated
    // Exports refuse to drop the user's edits silently.
    const edits = await readMarkdownEditsFile(task.outputDir, task.id)
    if (!edits.blocks.length && !edits.order) return { original: markdown, translated }
    const base = this.aligned(task.id, markdown, mappings)
    const { byIndex } = resolveMarkdownEdits(base, edits, sha256)
    const order = validOrder(edits.order, base.length)
    const ordered = <T>(items: T[]): T[] => inReadingOrder(items.map((item, index) => ({ item, index })), order, entry => entry.index).map(({ item }) => item)
    const indexed = blocks?.length === base.length && blocks.every((block, index) => block.sourceIndex === index)
    return {
      original: joinVisibleBlocks(ordered(effectiveOriginalBlocks(base, byIndex))),
      translated: indexed ? joinVisibleBlocks(ordered(blocks.map((block, index) => {
        const entry = byIndex.get(index)
        return { markdown: entry?.translated?.markdown ?? block.markdown, deleted: Boolean(entry?.deletedAt) }
      }))) : translated
    }
  }

  /** True when a translated block's source no longer matches the current original (e.g. after a text-layer repair). */
  async hasStaleTranslation(taskId: string): Promise<boolean> {
    const blocks = await this.loadTranslatedBlocks(await this.requireTask(taskId))
    return Boolean(blocks?.some((block) => block.sourceChanged))
  }

  /**
   * Source blocks whose Markdown no longer hashes to the manifest's `sourceHash`.
   * Uses the translation plan's own alignment; when the block count changed the
   * blocks cannot be paired, and nothing is marked.
   */
  private async changedSourceIndexes(task: CopilotixTask, manifestBlocks: unknown[]): Promise<Set<number>> {
    const recorded = manifestBlocks.flatMap((block) => isRecord(block) && Number.isInteger(block.sourceIndex) && typeof block.sourceHash === 'string'
      ? [[block.sourceIndex as number, block.sourceHash] as const] : [])
    if (recorded.length === 0) return new Set()
    try {
      const source = alignMarkdownBlocks(await this.readOptional(join(task.outputDir, 'full.md')), await this.loadMappings(task))
      if (source.length !== manifestBlocks.length) return new Set()
      return new Set(recorded.filter(([index, hash]) => source[index] && createHash('sha256').update(source[index]!.markdown).digest('hex') !== hash).map(([index]) => index))
    } catch {
      return new Set()
    }
  }

  async readOptional(path: string, fallback = ''): Promise<string> {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return fallback
    }
  }

  private async requireTask(taskId: string): Promise<CopilotixTask> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error('任务不存在')
    return task
  }
}

function readMappings(path: string): Promise<BlockMapping[]> {
  return readFile(path, 'utf8').then((value) => {
    const parsed = JSON.parse(value) as { mappings?: unknown }
    return Array.isArray(parsed.mappings) ? parsed.mappings as BlockMapping[] : []
  })
}

function isTranslationProvider(value: unknown): value is TranslationProviderId {
  return TRANSLATION_PROVIDER_IDS.includes(value as TranslationProviderId)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/**
 * The edit layer as the reader needs it. A translation is stale when it was made from different
 * original text: the manifest records each block's source hash, and a translated edit records the
 * original it was written against.
 */
export function resolveReaderEdits(markdown: string, mappings: BlockMapping[], translatedBlocks: readonly TranslatedMarkdownBlock[] | null, file: MarkdownEditsFile, aligned?: readonly EditableBlock[]): ResolvedMarkdownEdits {
  const mappingById = new Map(mappings.map((mapping) => [mapping.id, mapping]))
  const supplementalDeleted = file.supplementalDeleted.map(({ mappingId }) => ({ mappingId, excerpt: editExcerpt(mappingById.get(mappingId)?.sourceText ?? '') }))
  if (!file.blocks.length && !file.order) return { revision: file.revision, blocks: [], supplementalDeleted, boxMarks: file.boxMarks.map(item => item.mappingId), orphans: 0 }
  const base = aligned ?? alignMarkdownBlocks(markdown, readerContentMappings(mappings))
  const order = validOrder(file.order, base.length)
  const { byIndex, orphans } = resolveMarkdownEdits(base, file, sha256)
  const translatedBySource = new Map((translatedBlocks ?? []).map((block) => [block.sourceIndex, block]))
  const blocks = [...byIndex.entries()].sort(([a], [b]) => a - b).map(([index, entry]) => {
    const original = entry.original?.markdown ?? base[index]!.markdown
    const machine = translatedBySource.get(index)
    const stale = entry.translated ? entry.translated.sourceHash !== sha256(original)
      : Boolean(entry.original && machine && machine.sourceHash !== sha256(original))
    return {
      index, mappingIds: [...base[index]!.mappingIds], deleted: Boolean(entry.deletedAt), stale, excerpt: editExcerpt(original),
      ...(entry.original ? { original: entry.original.markdown } : {}),
      ...(entry.translated ? { translated: entry.translated.markdown } : {})
    }
  })
  return { revision: file.revision, blocks, supplementalDeleted, boxMarks: file.boxMarks.map(item => item.mappingId), ...(order ? { order } : {}), orphans: orphans.length }
}

function joinTranslatedMarkdownBlocks(blocks: readonly TranslatedMarkdownBlock[]): string {
  return `${blocks.map((block) => block.markdown.trimEnd()).join('\n\n')}\n`
}

/** Keep durable plan request/response internals out of user-exported archives. */
export function shouldIncludeResultZipEntry(name: string): boolean {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '')
  return normalized !== '.translation' && !normalized.startsWith('.translation/')
}
