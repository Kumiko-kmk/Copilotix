import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { BLOCK_MAPPING_VERSION } from '@features/parsing/core'
import { blockMappingSchema } from '@shared/ipcSchemas'
import { buildReaderFigureGeometries } from '@features/reader/core'
import { buildBriefContext, clip } from '../core/paperBrief/context'
import { FIGURE_INSIGHT_MAX_IMAGE_BYTES, FIGURE_INSIGHT_PROMPT_VERSION, figureInsightDescriptorSchema,
  figureInsightLocationSchema, figureInsightRecordSchema, figureInsightSaveSchema,
  type FigureInsightRequest, type FigureInsightDescriptor, type FigureInsightSave, type FigureInsightState, type FigureInsightRecord } from '../contract/figureInsight'
import { PathPolicy } from '@platform/files/runtime/pathPolicy'
import type { V2TaskRepositoryCompat } from '@features/library/utility'

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
const manifestSchema = z.object({ version: z.literal(1), figures: z.array(figureInsightLocationSchema).max(2000) }).strict()
const mappingsSchema = z.object({ version: z.literal(BLOCK_MAPPING_VERSION), mappings: z.array(blockMappingSchema).max(100_000) }).passthrough()

/** Utility owns source resolution and atomic persistence. The descriptor never carries PNG bytes. */
export class FigureInsightStore {
  private readonly policy = new PathPolicy()
  constructor(private readonly repository: Pick<V2TaskRepositoryCompat, 'getTask'>) {}

  private async root(documentId: string): Promise<string> {
    const task = this.repository.getTask(documentId)
    if (!task) throw new Error('论文不存在')
    const info = await lstat(task.outputDir)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('文献目录无效')
    return task.outputDir
  }

  private async read(root: string, name: string, limit: number): Promise<Buffer> {
    const path = this.policy.resolveChild(root, name)
    const info = await lstat(join(root, name))
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('图片解读来源无效或过大')
    const handle = await open(path, 'r')
    try {
      if ((await handle.stat()).size > limit) throw new Error('图片解读来源过大')
      const value = await handle.readFile()
      if (value.length > limit) throw new Error('图片解读来源过大')
      return value
    } finally { await handle.close() }
  }

  async descriptor(request: FigureInsightRequest, signal?: AbortSignal): Promise<FigureInsightDescriptor> {
    signal?.throwIfAborted()
    const root = await this.root(request.documentId)
    const task = this.repository.getTask(request.documentId)!
    const [manifestBytes, mappingBytes, layoutBytes, markdownBytes] = await Promise.all([
      this.read(root, 'figures.json', 4 * 1024 * 1024), this.read(root, 'block_list.json', 32 * 1024 * 1024),
      this.read(root, 'layout.json', 32 * 1024 * 1024), this.read(root, 'full.md', 32 * 1024 * 1024)
    ])
    signal?.throwIfAborted()
    const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')))
    const mappings = mappingsSchema.parse(JSON.parse(mappingBytes.toString('utf8'))).mappings
    const layout = layoutBytes.toString('utf8'), markdown = markdownBytes.toString('utf8')
    const geometry = buildReaderFigureGeometries(mappings, layout).find(g => g.id === request.figureId && g.status === 'complete')
    const figure = manifest.figures.find(f => f.figureId === request.figureId)
    if (!geometry || !figure) throw new Error('尚无已确认的完整大图，请先提取或打开阅读器生成整图')
    const pdf = await lstat(this.policy.resolveChild(root, 'original.pdf'))
    const revision = hash(JSON.stringify([task.sourceHash, pdf.size, pdf.mtimeMs, hash(layout)]))
    const geometryKey = JSON.stringify([geometry.pageIndex, geometry.cropBox, geometry.pageSize])
    const expectedPath = 'images/figures/figure-p' + (geometry.pageIndex + 1) + '-' + hash(revision + geometry.id + geometryKey).slice(0, 24) + '.png'
    if (figure.sourceRevision !== revision || figure.imagePath !== expectedPath) throw new Error('整图来源已变化，请重新提取')
    const png = await this.read(root, figure.imagePath, FIGURE_INSIGHT_MAX_IMAGE_BYTES)
    if (hash(png) !== figure.pngSha256 || png.length < 45 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      png.subarray(12, 16).toString() !== 'IHDR' || png.subarray(-8).toString('hex') !== '49454e44ae426082' ||
      png.readUInt32BE(16) !== figure.width || png.readUInt32BE(20) !== figure.height || figure.width * figure.height > 8_000_000) {
      throw new Error('整图校验失败')
    }
    const captionIndex = mappings.findIndex(m => m.id === geometry.captionMappingId)
    const memberIds = new Set(geometry.mappingIds)
    const captionParts = mappings.filter(m => m.id === geometry.captionMappingId ||
      (memberIds.has(m.id) && /^(?:image|chart)_caption$/u.test(m.type) && !/^\s*[（(]?[a-zA-Z][)）]?\s*$/u.test(m.sourceText)))
      .map(m => m.sourceText)
    const caption = clip([...new Set([...captionParts, geometry.fallbackLegendText].filter(Boolean))].join('\n'), 8000)
    const label = /^\s*((?:(?:supplementary|extended\s+data)\s+)?(?:fig(?:ure)?\.?|[附补補]?图|[附補]?圖)\s*(?:[A-Z]\.?\s*)?\d+[A-Z]?)/iu.exec(caption)?.[1]
    const compactLabel = (text: string): string => text.toLowerCase().replace(/figure/gu, 'fig').replace(/[\s.]/gu, '')
    const mentionsFigure = (text: string): boolean => Boolean(label && [...text.matchAll(
      /(?:(?:supplementary|extended\s+data)\s+)?(?:fig(?:ure)?\.?|[附补補]?图|[附補]?圖)\s*(?:[A-Z]\.?\s*)?\d+[A-Z]?(?![A-Za-z0-9])/giu
    )].some(match => compactLabel(match[0]) === compactLabel(label)))
    const related = new Set<string>()
    // Caption neighbours plus every matching figure mention and its paragraph neighbours.
    for (let index = 0; index < mappings.length; index++) {
      const mapping = mappings[index]!
      if (index !== captionIndex && !mentionsFigure(mapping.sourceText)) continue
      for (let offset = -2; offset <= 2; offset++) {
        const neighbour = mappings[index + offset]
        if (neighbour && neighbour.id !== geometry.captionMappingId && /^(?:text|aside_text)$/u.test(neighbour.type)) {
          related.add(clip(neighbour.sourceText, 3500))
        }
      }
    }
    const brief = buildBriefContext(markdown, '', 12 * 1024)
    const sourceRevision = hash(JSON.stringify([revision, figure.pngSha256, geometryKey, hash(markdownBytes), hash(mappingBytes)]))
    return figureInsightDescriptorSchema.parse({ ...request,
      figure: { ...figure, pageIndex: geometry.pageIndex, cropBox: geometry.cropBox, mappingIds: geometry.mappingIds, sourceAssets: geometry.assetSources },
      sourceRevision, imagePath: this.policy.resolveChild(root, figure.imagePath), imageBytes: png.length,
      context: { title: brief.title ? clip(brief.title, 2000) : null, caption, related: [...related].filter(Boolean).slice(0, 12),
        paperOverview: brief.excerpts.slice(0, 24).map(e => `${e.section}: ${e.text}`) }
    })
  }

  private name(figureId: string): string { return `insight/figures/${hash(figureId)}.v1.json` }

  async get(request: FigureInsightRequest): Promise<FigureInsightState> {
    const root = await this.root(request.documentId)
    let record: FigureInsightRecord
    try { record = figureInsightRecordSchema.parse(JSON.parse((await this.read(root, this.name(request.figureId), 64 * 1024)).toString('utf8'))) }
    catch (error) { if (absent(error)) return { status: 'missing' }; throw error }
    if (record.documentId !== request.documentId || record.figure.figureId !== request.figureId) throw new Error('图片解读不属于当前图片')
    let stale = record.provenance.promptVersion !== FIGURE_INSIGHT_PROMPT_VERSION
    try { stale ||= record.provenance.sourceRevision !== (await this.descriptor(request)).sourceRevision }
    catch { stale = true }
    return { status: 'ready', record, stale }
  }

  async save(raw: FigureInsightSave): Promise<{ saved: true }> {
    const request = figureInsightSaveSchema.parse(raw)
    const descriptor = await this.descriptor({ documentId: request.documentId, figureId: request.figureId })
    if (request.sourceRevision !== descriptor.sourceRevision) throw new Error('图片或正文已更新，请重新生成')
    const record = figureInsightRecordSchema.parse({ version: 1, documentId: request.documentId, figure: descriptor.figure,
      content: request.content, provenance: { sourceRevision: descriptor.sourceRevision, promptVersion: FIGURE_INSIGHT_PROMPT_VERSION,
        model: request.model, generatedAt: new Date().toISOString(), ...(request.upload ? { upload: request.upload } : {}) } })
    const root = await this.root(request.documentId)
    for (const name of ['insight', 'insight/figures']) {
      const path = this.policy.resolveChild(root, name)
      try { const stat = await lstat(join(root, name)); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('图片解读目录无效') }
      catch (error) { if (!absent(error)) throw error; await mkdir(path) }
    }
    const path = this.policy.resolveChild(root, this.name(request.figureId))
    try { if ((await lstat(join(root, this.name(request.figureId)))).isSymbolicLink()) throw new Error('解读文件不能是符号链接') }
    catch (error) { if (!absent(error)) throw error }
    const body = JSON.stringify(record)
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error('图片解读超过保存预算')
    const temporary = this.policy.resolveChild(root, `insight/figures/.pending-${randomUUID()}`)
    try {
      const handle = await open(temporary, 'wx')
      try { await handle.writeFile(body, 'utf8'); await handle.sync() } finally { await handle.close() }
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, path); break }
        catch (error) {
          if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
          await delay(100 * 2 ** attempt)
        }
      }
    } finally { await unlink(temporary).catch(() => undefined) }
    return { saved: true }
  }
}
