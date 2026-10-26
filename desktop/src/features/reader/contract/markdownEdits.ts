import { z } from 'zod'

/**
 * The reader's user-edit layer. Parsed and translated artifacts are never rewritten: a separate
 * file beside the paper replaces or hides whole content blocks, so repairs, re-parsing and
 * retranslation cannot overwrite the user's text. Positions refer to the content blocks of the
 * parsed Markdown as `alignMarkdownBlocks` splits them; annotation keys (`content:N`), mappings
 * and figure groups therefore stay those of the parsed text.
 */
export const MARKDOWN_EDITS_FILE = 'edits/markdown-edits.v1.json'
export const MARKDOWN_EDITS_MAX_BYTES = 16 * 1024 * 1024
export const MARKDOWN_EDIT_MAX_CHARS = 200_000

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const mappingIdSchema = z.string().min(1).max(256)
const timeSchema = z.string().datetime()
const blockText = z.string().max(MARKDOWN_EDIT_MAX_CHARS).refine(value => !value.includes('\0'))

export const markdownEditEntrySchema = z.object({
  /** Content block position when the edit was made. */
  index: z.number().int().min(0).max(1_000_000),
  mappingIds: z.array(mappingIdSchema).max(512),
  /** sha256 of the parsed block; finds the block again if a repair moved it. */
  baseHash: hashSchema,
  original: z.object({ markdown: blockText, editedAt: timeSchema }).strict().optional(),
  /** `sourceHash` is the original text the user translated against. */
  translated: z.object({ markdown: blockText, editedAt: timeSchema, sourceHash: hashSchema }).strict().optional(),
  deletedAt: timeSchema.optional(),
  /** The user asked to translate this block again; honoured by the first translation finished after it. */
  retranslateAt: timeSchema.optional()
}).strict()
export type MarkdownEditEntry = z.infer<typeof markdownEditEntrySchema>

export const markdownEditsFileSchema = z.object({
  version: z.literal(1),
  documentId: z.string().uuid(),
  revision: z.number().int().min(0),
  updatedAt: timeSchema,
  blocks: z.array(markdownEditEntrySchema).max(100_000),
  /** Page headers, footers and footnotes shown from the layout rather than the Markdown. */
  supplementalDeleted: z.array(z.object({ mappingId: mappingIdSchema, deletedAt: timeSchema }).strict()).max(100_000),
  /** Dashed whole-block frames set from the PDF view, by layout block ID (content or page furniture). */
  boxMarks: z.array(z.object({ mappingId: mappingIdSchema, markedAt: timeSchema }).strict()).max(100_000).default([]),
  /**
   * The user's reading order of the content blocks (2026-10-24): every position once, for a parse with
   * `count` blocks. Ignored, but kept, while the parse has a different number of blocks. Absent when
   * the parsed order is used, so files without a reordering stay readable by older builds.
   */
  order: z.object({ count: z.number().int().min(1).max(100_000), sequence: z.array(z.number().int().min(0).max(100_000)).max(100_000), updatedAt: timeSchema }).strict()
    .refine(value => isPermutation(value.sequence, value.count), 'Invalid block order').optional()
}).strict()
export type MarkdownEditsFile = z.infer<typeof markdownEditsFileSchema>
export const emptyMarkdownEdits = (documentId: string): MarkdownEditsFile =>
  ({ version: 1, documentId, revision: 0, updatedAt: new Date(0).toISOString(), blocks: [], supplementalDeleted: [], boxMarks: [] })

/** What the reader needs, resolved by Main against the current parsed text and translation. */
export const resolvedMarkdownEditsSchema = z.object({
  revision: z.number().int().min(0),
  blocks: z.array(z.object({
    index: z.number().int().min(0).max(1_000_000),
    mappingIds: z.array(mappingIdSchema).max(512),
    original: blockText.optional(),
    translated: blockText.optional(),
    deleted: z.boolean(),
    /** The translation shown was made from different original text. */
    stale: z.boolean(),
    /** Start of the block as shown, for the restore list. */
    excerpt: z.string().max(200)
  }).strict()).max(100_000),
  supplementalDeleted: z.array(z.object({ mappingId: mappingIdSchema, excerpt: z.string().max(200) }).strict()).max(100_000),
  boxMarks: z.array(mappingIdSchema).max(100_000),
  /** Content positions in reading order, when the user reordered blocks of this parse. */
  order: z.array(z.number().int().min(0).max(100_000)).max(100_000).optional(),
  /** Edits whose block no longer exists in the parsed text; kept in the file, not shown. */
  orphans: z.number().int().min(0)
}).strict()
export type ResolvedMarkdownEdits = z.infer<typeof resolvedMarkdownEditsSchema>

export const markdownEditActionSchema = z.enum(['set-original', 'set-translated', 'revert-original', 'revert-translated', 'delete', 'restore', 'retranslate', 'box', 'unbox', 'reorder', 'reset-order'])
export const markdownEditRequestSchema = z.object({
  documentId: z.string().uuid(),
  /** Optimistic concurrency: the revision the reader showed. */
  expectedRevision: z.number().int().min(0),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('content'), index: z.number().int().min(0).max(1_000_000), mappingIds: z.array(mappingIdSchema).max(512) }).strict(),
    z.object({ kind: z.literal('supplemental'), mappingId: mappingIdSchema }).strict(),
    /** Any layout block, for the dashed frame. */
    z.object({ kind: z.literal('block'), mappingId: mappingIdSchema }).strict(),
    /** The whole reading order; checked against the current parse when saved. */
    z.object({ kind: z.literal('order'), sequence: z.array(z.number().int().min(0).max(100_000)).max(100_000) }).strict()
  ]),
  action: markdownEditActionSchema,
  markdown: blockText.optional()
}).strict().refine(value => !value.action.startsWith('set-') || Boolean(value.markdown?.trim()), 'Edited text is required')
  .refine(value => value.target.kind !== 'supplemental' || value.action === 'delete' || value.action === 'restore', 'Only deletion applies to page furniture')
  .refine(value => (value.target.kind === 'block') === (value.action === 'box' || value.action === 'unbox'), 'Frames address layout blocks')
  .refine(value => (value.target.kind === 'order') === (value.action === 'reorder' || value.action === 'reset-order'), 'Reordering addresses the reading order')
export type MarkdownEditRequest = z.infer<typeof markdownEditRequestSchema>
// `edits`: the edit layer resolved after the change, so the reader need not reload the whole paper.
export const markdownEditResultSchema = z.object({ revision: z.number().int().min(0), edits: resolvedMarkdownEditsSchema.optional() }).strict()

/**
 * The reader's immediate view of a change, before the save returns: same shape as Main's resolution.
 * Staleness of an edited original is assumed; Main's answer replaces this within one round trip.
 */
export function optimisticEdits(current: ResolvedMarkdownEdits | null, request: Pick<MarkdownEditRequest, 'target' | 'action' | 'markdown'>, shownText = ''): ResolvedMarkdownEdits {
  const edits: ResolvedMarkdownEdits = current
    ? { ...current, blocks: [...current.blocks], supplementalDeleted: [...current.supplementalDeleted], boxMarks: [...(current.boxMarks ?? [])] }
    : { revision: 0, blocks: [], supplementalDeleted: [], boxMarks: [], orphans: 0 }
  const { target, action } = request
  if (target.kind === 'order') {
    delete edits.order
    if (action === 'reorder' && !isIdentity(target.sequence)) edits.order = [...target.sequence]
    return edits
  }
  if (target.kind === 'block') {
    edits.boxMarks = edits.boxMarks.filter(id => id !== target.mappingId)
    if (action === 'box') edits.boxMarks.push(target.mappingId)
    return edits
  }
  if (target.kind === 'supplemental') {
    edits.supplementalDeleted = edits.supplementalDeleted.filter(item => item.mappingId !== target.mappingId)
    if (action === 'delete') edits.supplementalDeleted.push({ mappingId: target.mappingId, excerpt: editExcerpt(shownText) })
    return edits
  }
  const at = edits.blocks.findIndex(block => block.index === target.index)
  const entry = at >= 0 ? { ...edits.blocks[at]! } : { index: target.index, mappingIds: [...target.mappingIds], deleted: false, stale: false, excerpt: '' }
  const text = request.markdown?.replace(/\r\n?/gu, '\n').trim()
  if (action === 'set-original' && text) { entry.original = text; entry.stale = true }
  else if (action === 'set-translated' && text) { entry.translated = text; entry.stale = false }
  else if (action === 'revert-original') delete entry.original
  else if (action === 'revert-translated') delete entry.translated
  else if (action === 'delete') entry.deleted = true
  else if (action === 'restore') entry.deleted = false
  entry.excerpt = editExcerpt(entry.original ?? shownText) || entry.excerpt
  const keep = entry.original !== undefined || entry.translated !== undefined || entry.deleted
  if (at >= 0) { if (keep) edits.blocks[at] = entry; else edits.blocks.splice(at, 1) }
  else if (keep) edits.blocks.push(entry)
  return edits
}

export interface EditableBlock { markdown: string; mappingIds: readonly string[] }
export type ResolvedEntry = MarkdownEditEntry & { baseChanged: boolean }

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join('\0') === [...b].sort().join('\0')

/**
 * Finds each edit's block: its recorded position when the mappings or text still match, else the
 * one block with the same mappings, else the one block with the same text. A block never takes two
 * edits; anything unmatched is an orphan and is kept, never applied to the wrong paragraph.
 */
export function resolveMarkdownEdits(blocks: readonly EditableBlock[], file: MarkdownEditsFile, hash: (text: string) => string): { byIndex: Map<number, ResolvedEntry>; orphans: MarkdownEditEntry[] } {
  const hashes = new Map<number, string>()
  const hashOf = (index: number): string => {
    let value = hashes.get(index)
    if (value === undefined) { value = hash(blocks[index]!.markdown); hashes.set(index, value) }
    return value
  }
  const byIndex = new Map<number, ResolvedEntry>()
  const orphans: MarkdownEditEntry[] = []
  for (const entry of file.blocks) {
    const free = (index: number): boolean => index >= 0 && index < blocks.length && !byIndex.has(index)
    const unique = (matches: number[]): number | undefined => matches.length === 1 ? matches[0] : undefined
    let found: number | undefined
    const at = blocks[entry.index]
    if (at && free(entry.index) && ((entry.mappingIds.length && sameIds(at.mappingIds, entry.mappingIds)) || hashOf(entry.index) === entry.baseHash)) found = entry.index
    if (found === undefined && entry.mappingIds.length) found = unique(blocks.flatMap((block, index) => free(index) && sameIds(block.mappingIds, entry.mappingIds) ? [index] : []))
    if (found === undefined) found = unique(blocks.flatMap((_, index) => free(index) && hashOf(index) === entry.baseHash ? [index] : []))
    if (found === undefined) { orphans.push(entry); continue }
    byIndex.set(found, { ...entry, index: found, baseChanged: hashOf(found) !== entry.baseHash })
  }
  return { byIndex, orphans }
}

/** Parsed blocks with the user's original-text edits applied; deleted blocks are flagged, not removed. */
export function effectiveOriginalBlocks<T extends EditableBlock>(blocks: readonly T[], byIndex: ReadonlyMap<number, ResolvedEntry>): Array<T & { deleted: boolean; edited: boolean }> {
  return blocks.map((block, index) => {
    const entry = byIndex.get(index)
    return { ...block, markdown: entry?.original?.markdown ?? block.markdown, deleted: Boolean(entry?.deletedAt), edited: Boolean(entry?.original) }
  })
}

/** Joins what the reader shows: deleted blocks out, edits in. */
export function joinVisibleBlocks(blocks: ReadonlyArray<{ markdown: string; deleted?: boolean }>): string {
  const visible = blocks.filter(block => !block.deleted).map(block => block.markdown.trimEnd())
  return visible.length ? `${visible.join('\n\n')}\n` : ''
}

export function isPermutation(sequence: readonly number[], count: number): boolean {
  if (sequence.length !== count) return false
  const seen = new Uint8Array(count)
  for (const index of sequence) {
    if (!Number.isInteger(index) || index < 0 || index >= count || seen[index]) return false
    seen[index] = 1
  }
  return true
}

export function isIdentity(sequence: readonly number[]): boolean {
  return sequence.every((index, position) => index === position)
}

/** The stored reading order when it fits a parse of `count` blocks; otherwise the parsed order applies. */
export function validOrder(order: MarkdownEditsFile['order'], count: number): number[] | null {
  return order && order.count === count && isPermutation(order.sequence, count) && !isIdentity(order.sequence) ? order.sequence : null
}

/** Items in reading order; `indexOf` gives an item's content position. Items without one keep their slot. */
export function inReadingOrder<T>(items: readonly T[], order: readonly number[] | null | undefined, indexOf: (item: T) => number | undefined): T[] {
  if (!order?.length) return [...items]
  const rank = new Map(order.map((index, position) => [index, position]))
  const ranked = items.filter(item => rank.has(indexOf(item) ?? -1))
  ranked.sort((a, b) => rank.get(indexOf(a)!)! - rank.get(indexOf(b)!)!)
  let next = 0
  return items.map(item => rank.has(indexOf(item) ?? -1) ? ranked[next++]! : item)
}

/** Moves `unit` (content positions) in front of `before` (or to the end); returns the whole new order. */
export function moveInOrder(order: readonly number[], unit: readonly number[], before: number | null): number[] {
  const moving = new Set(unit)
  const kept = order.filter(index => !moving.has(index))
  const at = before === null ? kept.length : kept.indexOf(before)
  const block = order.filter(index => moving.has(index))
  return at < 0 ? [...order] : [...kept.slice(0, at), ...block, ...kept.slice(at)]
}

export function editExcerpt(markdown: string): string {
  return markdown.replace(/!\[[^\]]*\]\([^)]*\)/gu, '[图片]').replace(/[#*_>`$|\\]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 120)
}
