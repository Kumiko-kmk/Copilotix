import { readDocumentModel } from '@features/document/main'
import { buildDocumentBase, getSnapshot, resolveDocumentEdits, resolveTranslations, readLegacyTranslations } from '@features/document/core'
import type { DocumentBase } from '@features/document/contract/documentModel'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import archiver from 'archiver'
import type { BlockMapping } from '@features/parsing/contract/blocks'
import type { DocumentPayload, CopilotixTask } from '@features/library/contract/documentTypes'
import type { TranslatedMarkdownBlock } from '@features/translation/contract/translationTypes'
import { normalizeMarkdown, isLocalMarkdownImage } from '@platform/markdown/core/standardMarkdown'
import type { PathPolicyPort } from '@platform/files/contract/pathPolicyPort'
import type { TaskComputePort } from '@features/library/contract/taskCompute'
import { BLOCK_MAPPING_VERSION, MARKDOWN_MAPPING_ALGORITHM_VERSION } from '@features/parsing/core'
import { type EditableBlock, type MarkdownEditsFile, type ResolvedMarkdownEdits } from '../contract/markdownEdits'
import { readMarkdownEditsFile } from '../runtime/markdownEditsFile'
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
    const base = await this.base(task, markdown, mappings, layoutJson)
    const modelDescriptor = this.compute.ensureDocumentModel ? { documentId: task.id, sourceVersion: base.sourceVersion, path: 'model/base.v1.json' as const, digest: sha256(JSON.stringify(base)) } : undefined
    const snapshot = getSnapshot(base, translatedMarkdown, translatedBlocks, edits, sha256)
    return {
      base, modelDescriptor,
      task,
      markdown: base.markdown,
      translatedMarkdown,
      translatedBlocks: resolveTranslations(base, translatedBlocks, sha256),
      layoutJson: base.layoutJson,
      mappings: base.mappings,
      markdownEdits: snapshot.edits,
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
      const geometries = document.base!.figures
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
    const figures = await readFigureArtifacts(document.task.outputDir, revision, document.base!.figures)
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
      const geometries = (await this.base(task, await this.readOptional(join(task.outputDir, 'full.md')), mappings, layout)).figures
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
      const manifest: unknown = JSON.parse(await readFile(join(task.outputDir, 'translation.manifest.json'), 'utf8'))
      const base = await this.base(task, await this.readOptional(join(task.outputDir, 'full.md')), await this.loadMappings(task))
      return resolveTranslations(base, readLegacyTranslations(manifest, base, sha256), sha256)
    } catch { return null }
  }

  /** The edit layer after a change, without sending the paper's text again. */
  async resolvedEdits(taskId: string): Promise<ResolvedMarkdownEdits> {
    const task = await this.requireTask(taskId)
    const [markdown, translatedBlocks, mappings, edits] = await Promise.all([
      this.readOptional(join(task.outputDir, 'full.md')), this.loadTranslatedBlocks(task), this.loadMappings(task),
      readMarkdownEditsFile(task.outputDir, task.id)
    ])
    const base = await this.base(task, markdown, mappings)
    return resolveDocumentEdits(markdown, mappings, translatedBlocks, edits, base.content, sha256, base.sourceVersion)
  }

  private async base(task: CopilotixTask, markdown: string, mappings: BlockMapping[], layoutJson = '{}'): Promise<DocumentBase> {
    if (this.compute.ensureDocumentModel) return readDocumentModel(task.outputDir, await this.compute.ensureDocumentModel(task.id), this.pathPolicy)
    // Compatibility for embedded hosts without the model RPC. Production always uses Utility.
    const [rawMappings, rawLayout] = await Promise.all([this.readOptional(join(task.outputDir, 'block_list.json')), this.readOptional(join(task.outputDir, 'layout.json'))])
    return buildDocumentBase(task.id, sha256(JSON.stringify([1, MARKDOWN_MAPPING_ALGORITHM_VERSION, markdown, rawMappings, rawLayout])), markdown, mappings, rawLayout || layoutJson)
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
    const model = await this.base(task, markdown, mappings)
    const snapshot = getSnapshot(model, translated, blocks, edits, sha256)
    return { original: snapshot.originalText, translated: snapshot.translatedText }
  }

  /** True when a translated block's source no longer matches the current original (e.g. after a text-layer repair). */
  async hasStaleTranslation(taskId: string): Promise<boolean> {
    const blocks = await this.loadTranslatedBlocks(await this.requireTask(taskId))
    return Boolean(blocks?.some((block) => block.sourceChanged))
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

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/**
 * The edit layer as the reader needs it. A translation is stale when it was made from different
 * original text: the manifest records each block's source hash, and a translated edit records the
 * original it was written against.
 */
export function resolveReaderEdits(markdown: string, mappings: BlockMapping[], translatedBlocks: readonly TranslatedMarkdownBlock[] | null, file: MarkdownEditsFile, aligned?: readonly EditableBlock[]): ResolvedMarkdownEdits {
  return resolveDocumentEdits(markdown, mappings, translatedBlocks, file, aligned, sha256)
}

function joinTranslatedMarkdownBlocks(blocks: readonly TranslatedMarkdownBlock[]): string {
  return `${blocks.map((block) => block.markdown.trimEnd()).join('\n\n')}\n`
}

/** Keep durable plan request/response internals out of user-exported archives. */
export function shouldIncludeResultZipEntry(name: string): boolean {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '')
  return normalized !== '.translation' && !normalized.startsWith('.translation/')
}
