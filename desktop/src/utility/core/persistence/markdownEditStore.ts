import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BLOCK_MAPPING_VERSION } from '@core/blockMapping'
import { blockMappingSchema } from '@shared/ipcSchemas'
import { alignMarkdownBlocks } from '@shared/markdownBlocks'
import { readerContentMappings } from '@shared/readerDocument'
import { isIdentity, isPermutation, markdownEditRequestSchema, resolveMarkdownEdits, validOrder, type MarkdownEditEntry, type MarkdownEditRequest, type MarkdownEditsFile } from '@shared/markdownEdits'
import { PathPolicy } from '@runtime/pathPolicy'
import { readMarkdownEditsFile, writeMarkdownEditsFile } from '@runtime/markdownEditsFile'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const mappingsSchema = z.object({ version: z.literal(BLOCK_MAPPING_VERSION), mappings: z.array(blockMappingSchema).max(100_000) }).passthrough()

/** Single writer of a paper's edit layer, on the Utility data lane; writes are serialized per paper. */
export class MarkdownEditStore {
  private readonly policy = new PathPolicy()
  private readonly tails = new Map<string, Promise<unknown>>()
  constructor(private readonly directory: (documentId: string) => string | null) {}

  private root(documentId: string): string {
    const root = this.directory(documentId)
    if (!root) throw new Error('论文不存在')
    return root
  }

  read(documentId: string): Promise<MarkdownEditsFile> { return readMarkdownEditsFile(this.root(documentId), documentId) }

  apply(raw: MarkdownEditRequest): Promise<{ revision: number }> {
    const request = markdownEditRequestSchema.parse(raw)
    const run = (this.tails.get(request.documentId) ?? Promise.resolve()).catch(() => undefined).then(() => this.applyNow(request))
    this.tails.set(request.documentId, run)
    void run.finally(() => { if (this.tails.get(request.documentId) === run) this.tails.delete(request.documentId) }).catch(() => undefined)
    return run
  }

  /** Rank of each mapping in the user's reading order, for the chat context; null without a reordering. */
  async readingOrder(documentId: string): Promise<Map<string, number> | null> {
    const root = this.root(documentId)
    const file = await readMarkdownEditsFile(root, documentId)
    if (!file.order) return null
    const blocks = await this.contentBlocks(root)
    const order = validOrder(file.order, blocks.length)
    if (!order) return null
    const rank = new Map<string, number>()
    order.forEach((index, position) => { for (const id of blocks[index]!.mappingIds) rank.set(id, position) })
    return rank
  }

  /** The reader's alignment of the current parse: positions and mapping identities as the user sees them. */
  private async contentBlocks(root: string): Promise<ReturnType<typeof alignMarkdownBlocks>> {
    const mappings = mappingsSchema.parse(JSON.parse(await this.text(root, 'block_list.json'))).mappings
    return alignMarkdownBlocks(await this.text(root, 'full.md'), readerContentMappings(mappings))
  }

  private async text(root: string, name: string): Promise<string> {
    const info = await lstat(join(root, name))
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error('论文解析结果无效')
    return readFile(this.policy.resolveChild(root, name), 'utf8')
  }

  private async applyNow(request: MarkdownEditRequest): Promise<{ revision: number }> {
    const root = this.root(request.documentId)
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('文献目录无效')
    const file = await readMarkdownEditsFile(root, request.documentId)
    if (file.revision !== request.expectedRevision) throw new Error('段落修改已在别处更新，请刷新后重试')
    const now = new Date().toISOString()
    const next: MarkdownEditsFile = { ...file, revision: file.revision + 1, updatedAt: now, blocks: [...file.blocks], supplementalDeleted: [...file.supplementalDeleted] }
    const target = request.target
    if (target.kind === 'order') {
      delete next.order
      if (request.action === 'reorder') {
        const count = (await this.contentBlocks(root)).length
        if (!isPermutation(target.sequence, count)) throw new Error('段落位置已变化，请刷新后重试')
        if (!isIdentity(target.sequence)) next.order = { count, sequence: [...target.sequence], updatedAt: now }
      }
    } else if (target.kind === 'block') {
      next.boxMarks = next.boxMarks.filter(item => item.mappingId !== target.mappingId)
      if (request.action === 'box') next.boxMarks.push({ mappingId: target.mappingId, markedAt: now })
    } else if (target.kind === 'supplemental') {
      next.supplementalDeleted = next.supplementalDeleted.filter(item => item.mappingId !== target.mappingId)
      if (request.action === 'delete') next.supplementalDeleted.push({ mappingId: target.mappingId, deletedAt: now })
    } else {
      // Positions and mapping identities must match what the user clicked.
      const blocks = await this.contentBlocks(root)
      const block = blocks[target.index]
      const sameIds = block && block.mappingIds.length === target.mappingIds.length && [...block.mappingIds].sort().join('\0') === [...target.mappingIds].sort().join('\0')
      if (!block || !sameIds) throw new Error('段落位置已变化，请刷新后重试')
      // Rewrite positions to the current parse so later edits find their blocks directly.
      const { byIndex, orphans } = resolveMarkdownEdits(blocks, file, sha256)
      const existing = byIndex.get(target.index)
      const entry: MarkdownEditEntry = existing
        ? (({ baseChanged: _changed, ...rest }) => rest)(existing)
        : { index: target.index, mappingIds: [...block.mappingIds], baseHash: sha256(block.markdown) }
      const text = request.markdown?.replace(/\r\n?/gu, '\n').trim() ?? ''
      if (request.action === 'set-original') {
        if (text === block.markdown.trim()) delete entry.original
        else entry.original = { markdown: text, editedAt: now }
      } else if (request.action === 'revert-original') delete entry.original
      else if (request.action === 'set-translated') entry.translated = { markdown: text, editedAt: now, sourceHash: sha256(entry.original?.markdown ?? block.markdown) }
      else if (request.action === 'revert-translated') delete entry.translated
      else if (request.action === 'delete') entry.deletedAt = now
      else if (request.action === 'retranslate') entry.retranslateAt = now
      else delete entry.deletedAt
      const kept = [...byIndex.entries()].filter(([index]) => index !== target.index).map(([, value]) => (({ baseChanged: _changed, ...rest }) => rest)(value))
      next.blocks = [...kept, ...(entry.original || entry.translated || entry.deletedAt || entry.retranslateAt ? [entry] : []), ...orphans].sort((a, b) => a.index - b.index)
    }
    await writeMarkdownEditsFile(root, next)
    return { revision: next.revision }
  }
}
