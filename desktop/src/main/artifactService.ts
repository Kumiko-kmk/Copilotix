import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import archiver from 'archiver'
import type { BlockMapping, DocumentPayload, CopilotixTask, TranslatedMarkdownBlock, TranslationProviderId } from '@shared/types'
import { TRANSLATION_PROVIDER_IDS } from '@shared/providerPolicy'
import { TABLE_TRANSLATION_PROTOCOL, TRANSLATION_PIPELINE_VERSION, LEGACY_TRANSLATION_PIPELINE_VERSION, STANDARD_TRANSLATION_PIPELINE_VERSION } from '@shared/translationPlanProtocol'
import { normalizeMarkdown, isLocalMarkdownImage } from '@shared/standardMarkdown'
import type { PathPolicyPort, TaskComputePort } from '@core/ports'
import { BLOCK_MAPPING_VERSION } from '@core/blockMapping'
import { MARKDOWN_MAPPING_ALGORITHM_VERSION } from '@shared/markdownBlocks'
import { buildReaderFigureGeometries } from '@shared/readerFigureGroups'
import { projectFigureMarkdown, type FigureArtifact } from '@shared/figureArtifacts'
import type { CacheDocumentFigureRequest, CacheDocumentFigureResult } from '@shared/ipcSchemas'
import { figureGeometryKey, figureSourceRevision, readFigureArtifacts, storeFigureArtifact, writeDerivedFile } from './figureArtifactStore'
import type { TaskRepositoryCompat } from './taskRepositoryCompat'

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
    const [markdown, translatedBlocks, storedTranslatedMarkdown, layoutJson, mappings] = await Promise.all([
      this.readOptional(join(task.outputDir, 'full.md')),
      this.loadTranslatedBlocks(task),
      this.readOptional(join(task.outputDir, 'full.zh-CN.md')),
      this.readOptional(join(task.outputDir, 'layout.json'), '{}'),
      this.loadMappings(task)
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
    const original = await this.figureProjection(task, await this.readOptional(join(task.outputDir, 'full.md')))
    const blocks = await this.loadTranslatedBlocks(task)
    const translated = await this.figureProjection(task, blocks?.length ? joinTranslatedMarkdownBlocks(blocks) : await this.readOptional(join(task.outputDir, 'full.zh-CN.md')))
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
    const blocks = kind === 'translated-markdown' ? await this.loadTranslatedBlocks(task) : null
    const source = blocks?.length ? joinTranslatedMarkdownBlocks(blocks)
      : await readFile(join(task.outputDir, kind === 'original-markdown' ? 'full.md' : 'full.zh-CN.md'), 'utf8')
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
      const blocks = manifest.blocks.map((block) => {
        if (!isRecord(block) || !Number.isInteger(block.sourceIndex) || (block.sourceIndex as number) < 0 || typeof block.markdown !== 'string') return null
        const mappingIds = Array.isArray(block.mappingIds) && block.mappingIds.every((id) => typeof id === 'string')
          ? [...block.mappingIds] as string[]
          : null
        // Older manifests may lack provider fields; those blocks simply carry no fallback mark.
        const fallbackProvider = block.status === 'completed' && isTranslationProvider(block.provider) &&
          isTranslationProvider(manifest.preferredProvider) && block.provider !== manifest.preferredProvider ? block.provider : undefined
        return { sourceIndex: block.sourceIndex as number, markdown: block.markdown, mappingIds, fallbackProvider }
      })
      if (blocks.some((block) => block === null)) return null
      const validBlocks = blocks as Array<{ sourceIndex: number; markdown: string; mappingIds: string[] | null; fallbackProvider?: TranslationProviderId }>
      const sourceIndexes = validBlocks.map((block) => block.sourceIndex)
      const validSourceOrder = new Set(sourceIndexes).size === sourceIndexes.length &&
        [...sourceIndexes].sort((left, right) => left - right).every((sourceIndex, index) => sourceIndex === index)
      const ordered = validSourceOrder
        ? [...validBlocks].sort((left, right) => left.sourceIndex - right.sourceIndex)
        : validBlocks
      const trustMappings = validSourceOrder && manifest.mappingAlgorithmVersion === MARKDOWN_MAPPING_ALGORITHM_VERSION &&
        manifest.blockMappingVersion === BLOCK_MAPPING_VERSION &&
        ordered.every((block) => Array.isArray(block.mappingIds))
      return ordered.map(({ sourceIndex, markdown, mappingIds, fallbackProvider }) => ({
        sourceIndex,
        markdown,
        mappingIds: trustMappings ? mappingIds ?? [] : [],
        ...(fallbackProvider ? { fallbackProvider } : {})
      }))
    } catch {
      return null
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

function joinTranslatedMarkdownBlocks(blocks: readonly TranslatedMarkdownBlock[]): string {
  return `${blocks.map((block) => block.markdown.trimEnd()).join('\n\n')}\n`
}

/** Keep durable plan request/response internals out of user-exported archives. */
export function shouldIncludeResultZipEntry(name: string): boolean {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '')
  return normalized !== '.translation' && !normalized.startsWith('.translation/')
}
