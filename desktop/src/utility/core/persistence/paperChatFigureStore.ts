import { createHash } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BLOCK_MAPPING_VERSION } from '@core/blockMapping'
import { blockMappingSchema } from '@shared/ipcSchemas'
import { buildReaderFigureGeometries } from '@shared/readerFigureGroups'
import { captionFigureKey } from '@shared/figureMentions'
import { PAPER_CHAT_MAX_FIGURE_IMAGES, PAPER_CHAT_MAX_IMAGE_BYTES, paperChatFigureRequestSchema, paperChatFigureSourceSchema,
  type PaperChatFigureRequest, type PaperChatFigureSource } from '@shared/paperChatFigures'
import { PathPolicy } from '@platform/files/runtime/pathPolicy'
import type { FigureInsightStore } from '@features/insight/utility'
import type { V2TaskRepositoryCompat } from './v2TaskRepositoryCompat'

const mappingsSchema = z.object({ version: z.literal(BLOCK_MAPPING_VERSION), mappings: z.array(blockMappingSchema).max(100_000) }).passthrough()
const PANEL_NAME = /^[A-Za-z0-9_-]{1,128}\.(?:jpe?g|png)$/iu

/**
 * Resolves a reader figure for a chat question: the verified whole-figure crop when the reader has
 * saved one, otherwise the parsed panel images. Returns paths and hashes only, never image bytes.
 */
export class PaperChatFigureStore {
  private readonly policy = new PathPolicy()
  constructor(private readonly repository: Pick<V2TaskRepositoryCompat, 'getTask'>, private readonly figures: Pick<FigureInsightStore, 'descriptor'>) {}

  private async read(root: string, name: string, limit: number): Promise<Buffer> {
    const path = this.policy.resolveChild(root, name)
    const info = await lstat(join(root, name))
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('图片来源无效或过大')
    const handle = await open(path, 'r')
    try {
      const value = await handle.readFile()
      if (value.length > limit) throw new Error('图片来源过大')
      return value
    } finally { await handle.close() }
  }

  async source(raw: PaperChatFigureRequest, signal?: AbortSignal): Promise<PaperChatFigureSource> {
    const request = paperChatFigureRequestSchema.parse(raw)
    signal?.throwIfAborted()
    const task = this.repository.getTask(request.documentId)
    if (!task) throw new Error('论文不存在')
    const root = task.outputDir
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('文献目录无效')
    const [mappingBytes, layoutBytes] = await Promise.all([this.read(root, 'block_list.json', 32 * 1024 * 1024), this.read(root, 'layout.json', 32 * 1024 * 1024)])
    signal?.throwIfAborted()
    const mappings = mappingsSchema.parse(JSON.parse(mappingBytes.toString('utf8'))).mappings
    const geometry = buildReaderFigureGeometries(mappings, layoutBytes.toString('utf8')).find(item => item.id === request.figureId)
    if (!geometry) throw new Error('图片已不在当前解析版本中，请重新加入')
    const members = new Set(geometry.mappingIds)
    const captionMappings = mappings.filter(m => m.id === geometry.captionMappingId ||
      (members.has(m.id) && /^(?:image|chart)_caption$/u.test(m.type) && !/^\s*[（(]?[a-zA-Z][)）]?\s*$/u.test(m.sourceText)))
    const caption = [...new Set([...captionMappings.map(m => m.sourceText), geometry.fallbackLegendText].filter(Boolean))].join('\n').slice(0, 8000)
    const labelled = captionFigureKey(caption)

    let whole = false
    const images: PaperChatFigureSource['images'] = []
    if (geometry.status === 'complete') {
      // The crop exists once the reader has saved it; until then the panels stand in.
      const descriptor = await this.figures.descriptor(request, signal).catch(() => null)
      if (descriptor) {
        whole = true
        images.push({ path: descriptor.figure.imagePath, absolutePath: descriptor.imagePath, bytes: descriptor.imageBytes, sha256: descriptor.figure.pngSha256, mimeType: 'image/png' })
      }
    }
    if (!whole) {
      for (const asset of geometry.assetSources) {
        if (images.length >= PAPER_CHAT_MAX_FIGURE_IMAGES) break
        const name = asset.replace(/\\/gu, '/').split(/[?#]/u)[0]!.split('/').pop() ?? ''
        if (!PANEL_NAME.test(name) || images.some(image => image.path === `images/${name}`)) continue
        signal?.throwIfAborted()
        const bytes = await this.read(root, `images/${name}`, PAPER_CHAT_MAX_IMAGE_BYTES)
        const png = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
        if (!png && bytes.subarray(0, 3).toString('hex') !== 'ffd8ff') throw new Error('图片格式不受支持')
        images.push({ path: `images/${name}`, absolutePath: this.policy.resolveChild(root, `images/${name}`), bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: png ? 'image/png' : 'image/jpeg' })
      }
    }
    if (!images.length) throw new Error('这张图还没有可用的图片文件，请稍后重试')
    return paperChatFigureSourceSchema.parse({ ...request, label: labelled?.label ?? null, key: labelled?.key ?? null,
      pageIndex: geometry.pageIndex, caption, captionMappingIds: captionMappings.map(m => m.id).slice(0, 64),
      mappingIds: geometry.mappingIds.slice(0, 512), whole, images })
  }
}
