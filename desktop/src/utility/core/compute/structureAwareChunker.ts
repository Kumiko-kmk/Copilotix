import { createHash } from 'node:crypto'
import type { BlockMapping } from '@shared/types'
import type { RagChunk, RagChunkContentType, RagChunkInput, RagMappingConfidence } from '@core/types'
import { alignMarkdownBlocks, parseMarkdownAst, stringifyMarkdownAst } from '@shared/markdownBlocks'

export { STRUCTURE_AWARE_CHUNKER_VERSION, TOKEN_ESTIMATOR_VERSION, STRUCTURE_AWARE_CHUNKER_FINGERPRINT } from '@shared/ragVersion'

export const DEFAULT_CHUNK_TARGET_TOKENS = 420
export const DEFAULT_CHUNK_HARD_MAX_TOKENS = 700
export const MAX_CHUNK_OVERLAP_TOKENS = 64

export interface StructureAwareChunkInput {
  documentId: string
  artifactId?: string
  contentRevisionId: string
  contentHash: string
  sourceText: string
  mappings?: readonly BlockMapping[]
}

/** Port adapter used by future Utility pipelines without exposing AST data. */
export class StructureAwareChunker {
  chunk(input: RagChunkInput, signal?: AbortSignal): Promise<readonly RagChunk[]> {
    if (signal?.aborted) return Promise.reject(new Error('RAG_CONTENT_INDEX_CANCELLED'))
    return Promise.resolve(structureAwareChunk(input))
  }
}

type AstNode = {
  type?: string
  value?: string
  depth?: number
  lang?: string | null
  children?: AstNode[]
  position?: { start?: { offset?: number }; end?: { offset?: number } }
}

type Leaf = {
  node: AstNode
  markdown: string
  contentType: RagChunkContentType
  sectionPath: string[]
  mappingIds: string[]
  start: number | null
  end: number | null
}

/**
 * A provider-independent, deterministic estimator.  It deliberately counts
 * Unicode code points (not UTF-16 code units), while source offsets remain
 * JavaScript/UTF-16 offsets.  Therefore an emoji or surrogate pair can never
 * be cut in half and a provider tokenizer changing later cannot change IDs.
 */
export function estimateTokens(value: string): number {
  let total = 0
  let latinRun = 0
  const flushLatin = (): void => {
    if (latinRun > 0) total += Math.ceil(latinRun / 4)
    latinRun = 0
  }
  for (const char of Array.from(value)) {
    if (/\s/u.test(char)) {
      flushLatin()
      continue
    }
    if (/^[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]$/u.test(char) || /\p{Extended_Pictographic}/u.test(char)) {
      flushLatin()
      total += 1
      continue
    }
    if (/^[\p{L}\p{N}]$/u.test(char)) {
      latinRun += 1
      continue
    }
    flushLatin()
    total += 1
  }
  flushLatin()
  return total
}

export function structureAwareChunk(input: StructureAwareChunkInput): readonly RagChunk[] {
  if (!input.documentId || !input.contentRevisionId || !input.contentHash) throw new Error('RAG_CHUNK_INVALID_INPUT')
  const markdown = input.sourceText
  const mappings = input.mappings ?? []
  const aligned = alignMarkdownBlocks(markdown, [...mappings])
  const root = parseMarkdownAst(markdown) as AstNode
  const children = Array.isArray(root.children) ? root.children : []
  const leaves: Leaf[] = []
  let sectionPath: string[] = []
  const headingStack: Array<{ depth: number; title: string }> = []
  let alignedCursor = 0

  for (const node of children) {
    const type = node.type ?? 'other'
    if (type === 'heading') {
      const title = visibleText(node).trim()
      if (title) {
        const depth = Math.max(1, node.depth ?? 1)
        // Markdown can skip levels (H1 -> H3). Array length is not depth:
        // discard actual peers/descendants before adding the new heading.
        while (headingStack.length && headingStack[headingStack.length - 1]!.depth >= depth) headingStack.pop()
        headingStack.push({ depth, title })
        sectionPath = headingStack.map((heading) => sectionLabel(heading.title))
        // Heading chunks are stable parent anchors.  Leaf chunks carry the
        // same sectionPath, which provides a resolvable parent/child relation
        // without changing the pre-existing v4 schema.
        leaves.push(makeLeaf(node, 'heading', sectionPath, aligned, alignedCursor, mappings, markdown))
      }
      alignedCursor += 1
      continue
    }
    const contentType = contentTypeFor(node)
    leaves.push(makeLeaf(node, contentType, sectionPath, aligned, alignedCursor, mappings, markdown))
    alignedCursor += 1
  }

  const chunks: RagChunk[] = []
  for (const leaf of leaves) {
    const pieces = splitLeaf(leaf)
    for (const piece of pieces) {
      const ordinal = chunks.length
      const contentHash = sha256(piece.text)
      const chunkId = sha256(`${input.documentId}\u0000${input.contentRevisionId}\u0000${ordinal}\u0000${contentHash}\u0000${piece.contentType}`)
      const provenance = provenanceFor(piece.mappingIds, mappings, piece.wasSplit)
      chunks.push({
        chunkId,
        contentRevisionId: input.contentRevisionId,
        ordinal,
        contentHash,
        sourceText: piece.text,
        sectionPath: [...piece.sectionPath],
        mappingIds: [...piece.mappingIds],
        pageStart: provenance.pageStart,
        pageEnd: provenance.pageEnd,
        sourceStartOffset: piece.start,
        sourceEndOffset: piece.end,
        offsetUnit: 'utf16',
        tokenCount: estimateTokens(piece.text),
        contentType: piece.contentType,
        mappingConfidence: provenance.confidence
      })
    }
  }
  return chunks
}

/** Labels are bounded metadata; complete heading text stays in source chunks. */
function sectionLabel(title: string): string {
  const normalized = title.replace(/\p{Cc}/gu, ' ').trim()
  if (normalized.length <= 512) return normalized
  let prefix = normalized.slice(0, 511)
  if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1)
  return `${prefix}\u2026`
}

function makeLeaf(
  node: AstNode,
  contentType: RagChunkContentType,
  path: readonly string[],
  aligned: readonly { markdown: string; mappingIds: string[] }[],
  alignedIndex: number,
  mappings: readonly BlockMapping[],
  sourceText: string
): Leaf {
  const start = node.position?.start?.offset ?? null
  const end = node.position?.end?.offset ?? null
  const markdown = start !== null && end !== null && end >= start
    ? sourceText.slice(start, end)
    : stringifyMarkdownAst(node) || visibleText(node)
  // Top-level alignment is ordered and duplicate-safe.  For a malformed AST
  // index, fall back to the first unused textual match deterministically.
  let mappingIds = aligned[alignedIndex]?.mappingIds ?? []
  if (mappingIds.length === 0 && markdown) {
    const candidate = aligned.find((item) => item.markdown === markdown)
    mappingIds = candidate?.mappingIds ?? []
  }
  mappingIds = mappingIds.filter((id) => mappings.some((mapping) => mapping.id === id))
  return { node, markdown, contentType, sectionPath: [...path], mappingIds, start, end }
}

function splitLeaf(leaf: Leaf): Array<{
  text: string
  start: number | null
  end: number | null
  sectionPath: string[]
  mappingIds: string[]
  contentType: RagChunkContentType
  wasSplit: boolean
}> {
  const text = leaf.markdown
  if (!text) return []
  const count = estimateTokens(text)
  if (count <= DEFAULT_CHUNK_HARD_MAX_TOKENS) {
    return [{ text, start: leaf.start, end: leaf.end, sectionPath: leaf.sectionPath, mappingIds: leaf.mappingIds, contentType: leaf.contentType, wasSplit: false }]
  }

  // Tables retain a minimal column header when split.  The AST is already
  // parsed by remark; this deliberately does not attempt to parse Markdown
  // with regular expressions.  A row may be wider than the hard limit, so
  // columns are grouped deterministically and an oversized cell is split at
  // Unicode code-point boundaries.
  if (leaf.node.type === 'table' && leaf.node.children?.length) {
    return splitTableLeaf(leaf)
  }
  return splitText(leaf)
}

function splitTableLeaf(leaf: Leaf): ReturnType<typeof splitLeaf> {
  const rows = leaf.node.children ?? []
  const header = tableCells(rows[0]!).map((cell, index) => visibleText(cell).trim() || `Column ${index + 1}`)
  const dataRows = rows.slice(1).map((row) => tableCells(row).map((cell) => visibleText(cell).trim()))
  const result: ReturnType<typeof splitLeaf> = []
  let pending: string[] = []

  const append = (text: string): void => {
    if (!text) return
    result.push({ text, start: leaf.start, end: leaf.end, sectionPath: leaf.sectionPath, mappingIds: leaf.mappingIds, contentType: 'table', wasSplit: true })
  }

  for (const row of dataRows.length ? dataRows : [[]]) {
    const rowParts = splitTableRow(header, row)
    for (const rowPart of rowParts) {
      const candidate = pending.length ? `${pending.join('\n')}\n${rowPart}` : rowPart
      if (pending.length && estimateTokens(candidate) > DEFAULT_CHUNK_HARD_MAX_TOKENS) {
        append(pending.join('\n'))
        pending = []
      }
      if (estimateTokens(rowPart) > DEFAULT_CHUNK_HARD_MAX_TOKENS) {
        // Defensive final bound.  splitTableRow should already guarantee
        // this, but keeping the invariant here protects future renderers.
        for (const part of safeHardSplit(rowPart)) append(part)
      } else {
        pending.push(rowPart)
      }
    }
  }
  if (pending.length) append(pending.join('\n'))
  return result
}

function splitTableRow(header: readonly string[], row: readonly string[]): string[] {
  const columns = Math.max(header.length, row.length, 1)
  const normalizedHeader = Array.from({ length: columns }, (_, index) => header[index] ?? `Column ${index + 1}`)
  const normalizedRow = Array.from({ length: columns }, (_, index) => row[index] ?? '')
  const parts: string[] = []
  let start = 0
  while (start < columns) {
    let end = start + 1
    while (end < columns) {
      const candidate = renderTableGroup(normalizedHeader.slice(start, end + 1), normalizedRow.slice(start, end + 1))
      if (estimateTokens(candidate) > DEFAULT_CHUNK_HARD_MAX_TOKENS) break
      end += 1
    }
    const headers = normalizedHeader.slice(start, end)
    const values = normalizedRow.slice(start, end)
    const group = renderTableGroup(headers, values)
    if (estimateTokens(group) <= DEFAULT_CHUNK_HARD_MAX_TOKENS) {
      parts.push(group)
    } else {
      parts.push(...splitOversizedTableGroup(headers, values))
    }
    start = end
  }
  return parts
}

function splitOversizedTableGroup(headers: readonly string[], values: readonly string[]): string[] {
  const results: string[] = []
  const count = Math.max(headers.length, values.length, 1)
  for (let index = 0; index < count; index += 1) {
    const header = headers[index] ?? `Column ${index + 1}`
    const value = values[index] ?? ''
    const whole = renderTableGroup([header], [value])
    if (estimateTokens(whole) <= DEFAULT_CHUNK_HARD_MAX_TOKENS) {
      results.push(whole)
      continue
    }
    // The value budget must include the complete header.  Splitting the value
    // first and then splitting the rendered candidate can produce a naked
    // continuation chunk, which is not independently identifiable.
    results.push(...splitTableCellWithHeader(header, value))
  }
  return results
}

function splitTableCellWithHeader(header: string, value: string): string[] {
  const prefix = `Table columns: ${header}\nRow: `
  const prefixTokens = estimateTokens(`${prefix}(empty)`)
  if (prefixTokens > DEFAULT_CHUNK_HARD_MAX_TOKENS) {
    // An overlong header is an unavoidable synthetic representation.  Every
    // fragment remains labelled as a table-header fragment and is never a
    // bare piece of text.  The row marker makes the generated provenance
    // explicit to downstream display/citation code.
    return [
      ...splitHeaderFragments(header),
      ...splitTableValueWithHeader('(header fragment; see preceding labelled fragments)', value)
    ]
  }

  return splitTableValueWithHeader(header, value)
}

function splitTableValueWithHeader(header: string, value: string): string[] {
  const chars = Array.from(value)
  if (chars.length === 0) return [renderTableGroup([header], [''])]
  const parts: string[] = []
  let start = 0
  while (start < chars.length) {
    const length = largestTableValuePrefix(header, chars, start)
    if (length <= 0) {
      // A single code point should always fit when the header itself fits;
      // retain the invariant defensively if the estimator changes later.
      parts.push(...splitHeaderFragments(header))
      start += 1
      continue
    }
    const valuePart = chars.slice(start, start + length).join('')
    parts.push(renderTableGroup([header], [valuePart]))
    start += length
  }
  return parts
}

function largestTableValuePrefix(header: string, chars: readonly string[], start: number): number {
  let low = 1
  let high = chars.length - start
  let best = 0
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const valuePart = chars.slice(start, start + middle).join('')
    if (estimateTokens(renderTableGroup([header], [valuePart])) <= DEFAULT_CHUNK_HARD_MAX_TOKENS) {
      best = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  if (best <= 1 || start + best >= chars.length) return best
  // Prefer a nearby whitespace boundary so a long cell containing ordinary
  // terms does not resume with half an identifier. Fall back to the
  // code-point-safe limit for genuinely unbroken content.
  const minimumUsefulBoundary = Math.max(1, Math.floor(best * 0.6))
  for (let length = best; length >= minimumUsefulBoundary; length -= 1) {
    if (/\s/u.test(chars[start + length - 1] ?? '')) return length
  }
  return best
}

function splitHeaderFragments(header: string): string[] {
  const label = 'Table columns: (header fragment) '
  const rowLabel = 'header fragment'
  const chars = Array.from(header)
  const parts: string[] = []
  let start = 0
  while (start < chars.length) {
    let low = 1
    let high = chars.length - start
    let best = 0
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const fragment = chars.slice(start, start + middle).join('')
      const candidate = `${label}${fragment}\nRow: ${rowLabel}`
      if (estimateTokens(candidate) <= DEFAULT_CHUNK_HARD_MAX_TOKENS) {
        best = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    if (best <= 0) best = 1
    const fragment = chars.slice(start, start + best).join('')
    parts.push(`${label}${fragment}\nRow: ${rowLabel}`)
    start += best
  }
  return parts.length ? parts : [`${label}(empty)\nRow: ${rowLabel}`]
}

function renderTableGroup(headers: readonly string[], values: readonly string[]): string {
  const headerText = headers.map((value) => value || '(unnamed)').join(' | ')
  const valueText = values.map((value) => value || '(empty)').join(' | ')
  return `Table columns: ${headerText}\nRow: ${valueText}`
}

function tableCells(row: AstNode): AstNode[] {
  return Array.isArray(row.children) ? row.children : []
}

function splitText(leaf: Leaf): ReturnType<typeof splitLeaf> {
  const boundaries = sentenceBoundaries(leaf.markdown)
  const pieces: ReturnType<typeof splitLeaf> = []
  let pieceStart = 0
  let piece = ''
  for (const boundary of boundaries) {
    const candidate = leaf.markdown.slice(pieceStart, boundary.end)
    if (piece && estimateTokens(candidate) > DEFAULT_CHUNK_HARD_MAX_TOKENS) {
      pieces.push(pieceFrom(leaf, piece, pieceStart, boundary.start, true))
      pieceStart = boundary.start
      piece = ''
    }
    piece = leaf.markdown.slice(pieceStart, boundary.end)
    if (estimateTokens(piece) > DEFAULT_CHUNK_HARD_MAX_TOKENS) {
      const hardPieces = safeHardSplit(piece)
      let cursor = pieceStart
      for (const hardPiece of hardPieces.slice(0, -1)) {
        pieces.push(pieceFrom(leaf, hardPiece, cursor, cursor + hardPiece.length, true))
        cursor += hardPiece.length
      }
      pieceStart = cursor
      piece = leaf.markdown.slice(cursor, boundary.end)
    }
  }
  if (piece.trim()) pieces.push(pieceFrom(leaf, piece, pieceStart, leaf.markdown.length, true))
  return pieces
}

function pieceFrom(leaf: Leaf, text: string, localStart: number, localEnd: number, wasSplit: boolean): ReturnType<typeof splitLeaf>[number] {
  const absoluteStart = leaf.start === null ? null : leaf.start + localStart
  const absoluteEnd = leaf.start === null ? null : Math.min(leaf.end ?? (leaf.start + localEnd), leaf.start + localEnd)
  return { text, start: absoluteStart, end: absoluteEnd, sectionPath: leaf.sectionPath, mappingIds: leaf.mappingIds, contentType: leaf.contentType, wasSplit }
}

function sentenceBoundaries(text: string): Array<{ start: number; end: number }> {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter('und', { granularity: 'sentence' })
    return [...segmenter.segment(text)].map((segment) => ({ start: segment.index, end: segment.index + segment.segment.length }))
  }
  // Conservative fallback: code-point-safe line/whitespace boundaries.
  const boundaries: Array<{ start: number; end: number }> = []
  let start = 0
  for (const match of text.matchAll(/\n+|\s+/gu)) {
    const end = (match.index ?? 0) + match[0].length
    boundaries.push({ start, end })
    start = end
  }
  if (start < text.length) boundaries.push({ start, end: text.length })
  return boundaries.length ? boundaries : [{ start: 0, end: text.length }]
}

function safeHardSplit(text: string): string[] {
  const chars = Array.from(text)
  const pieces: string[] = []
  let start = 0
  while (start < chars.length) {
    // Binary search the largest code-point-safe prefix under the token cap.
    // Recomputing the estimator for every appended character is quadratic for
    // long unbroken cells and paragraphs.
    let low = 1
    let high = chars.length - start
    let best = 0
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = chars.slice(start, start + middle).join('')
      if (estimateTokens(candidate) <= DEFAULT_CHUNK_HARD_MAX_TOKENS) {
        best = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    if (best === 0) best = 1
    pieces.push(chars.slice(start, start + best).join(''))
    start += best
  }
  return pieces.length ? pieces : [text]
}

function contentTypeFor(node: AstNode): RagChunkContentType {
  switch (node.type) {
    case 'paragraph': return isCaption(node) ? 'caption' : 'paragraph'
    case 'list': return 'list'
    case 'code': return 'code'
    case 'math':
    case 'inlineMath': return 'formula'
    case 'table': return 'table'
    case 'heading': return 'heading'
    default: return 'other'
  }
}

function isCaption(node: AstNode): boolean {
  const value = visibleText(node).trim()
  return /^(?:table|tab\.|figure|fig\.|图|表)\s*[\d一二三四五六七八九十]*[:：.、\s]/iu.test(value)
}

function visibleText(node: AstNode): string {
  if (!node || typeof node !== 'object') return ''
  if (typeof node.value === 'string') {
    if (node.type === 'html') return node.value.replace(/<[^>]*>/gu, ' ')
    return node.value
  }
  if (node.type === 'image' || node.type === 'imageReference') return typeof (node as AstNode & { alt?: unknown }).alt === 'string' ? String((node as AstNode & { alt: string }).alt) : ''
  return Array.isArray(node.children) ? node.children.map(visibleText).filter(Boolean).join(' ') : ''
}

function provenanceFor(mappingIds: readonly string[], mappings: readonly BlockMapping[], split: boolean): { pageStart: number | null; pageEnd: number | null; confidence: RagMappingConfidence } {
  const selected = mappingIds.map((id) => mappings.find((mapping) => mapping.id === id)).filter((mapping): mapping is BlockMapping => Boolean(mapping))
  const boxes = selected.flatMap((mapping) => mapping.boxes).filter((box) => !box.isDiscarded)
  if (selected.length === 0) return { pageStart: null, pageEnd: null, confidence: 'none' }
  if (boxes.length === 0) return { pageStart: null, pageEnd: null, confidence: 'fallback' }
  const pages = boxes.map((box) => box.pageIndex).sort((a, b) => a - b)
  const media = selected.some((mapping) => ['image', 'chart', 'figure'].includes(mapping.type))
  return {
    pageStart: pages[0] ?? null,
    pageEnd: pages[pages.length - 1] ?? null,
    confidence: media ? 'media' : split || selected.length > 1 || boxes.length > 1 ? 'range' : 'exact'
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
