/**
 * Repair parser text spans that lost most of their glyphs, using the PDF's own
 * text layer. MinerU sometimes recognises a line from a box clipped to the
 * ascender band, which keeps only letters such as `d h f l` and drops the
 * rest. The PDF text layer of the same box still holds the real words.
 *
 * Only plain `text` spans are considered. Equations, tables and images are
 * never touched, and a span is replaced only when the text layer is readable
 * and the parser output is an in-order remnant of it. Scanned PDFs (no text
 * layer) and unreadable font encodings therefore keep the parser output.
 */

export const TEXT_LAYER_REPAIR_VERSION = 1

export type TextLayerBbox = [number, number, number, number]

export interface TextLayerItem {
  text: string
  /** Glyph box in layout page coordinates (top-left origin, same unit as `page_size`). */
  bbox: TextLayerBbox
}

export interface TextLayerPage {
  pageIndex: number
  items: TextLayerItem[]
}

export interface TextLayerCandidate {
  pageIndex: number
  /** Page size from the layout, used to scale PDF coordinates. */
  pageSize: [number, number]
  bbox: TextLayerBbox
  content: string
}

export interface TextLayerRepair {
  pageIndex: number
  bbox: TextLayerBbox
  original: string
  replacement: string
}

export interface TextLayerRepairReport {
  version: typeof TEXT_LAYER_REPAIR_VERSION
  repairs: TextLayerRepair[]
  /** Fragmented spans the text layer could not confirm; they keep the parser text. */
  unresolved: TextLayerCandidate[]
}

interface SpanRef {
  candidate: TextLayerCandidate
  span: Record<string, unknown>
  /** Text of the previous text span in the same block, used to disambiguate Markdown matches. */
  previous: string
}

/**
 * True when most "words" are single lowercase letters, e.g. `d h f ld h h d f l ll d h d`.
 * Letter-spaced headings (`A B S T R A C T`) and author initials are uppercase;
 * variable lists such as `a b c` are rejected later because their text layer
 * is not longer than the span.
 */
export function isFragmentedText(content: string): boolean {
  const words = content.trim().split(/\s+/u).filter((token) => /\p{L}/u.test(token))
  if (words.length < 6) return false
  const lengths = words.map((word) => letters(word).length)
  const single = words.filter((word) => /^\p{Ll}$/u.test(letters(word))).length
  const total = lengths.reduce((sum, length) => sum + length, 0)
  return single / words.length >= 0.4 && lengths.filter((length) => length === 1).length / words.length >= 0.5 && total / words.length <= 2
}

/** Fragmented `text` spans of a MinerU layout (`pdf_info[].para_blocks`, including nested blocks). */
export function findTextLayerCandidates(layout: unknown): TextLayerCandidate[] {
  return collectSpans(layout).map((ref) => ref.candidate)
}

/** Text of the layer items that sit on the box's line, in left-to-right order. Null when the box spans several lines. */
export function textInBox(items: readonly TextLayerItem[], bbox: TextLayerBbox): string | null {
  const [x0, y0, x1, y1] = bbox
  const boxHeight = y1 - y0
  const pieces: Array<{ text: string; left: number; right: number; top: number; bottom: number }> = []
  for (const item of items) {
    const [ix0, iy0, ix1, iy1] = item.bbox
    const itemHeight = iy1 - iy0
    if (!item.text.trim() || itemHeight <= 0 || ix1 <= ix0) continue
    const overlap = Math.min(y1, iy1) - Math.max(y0, iy0)
    if (overlap < 0.5 * Math.min(boxHeight, itemHeight)) continue
    const tolerance = 0.5 * itemHeight
    if (ix0 >= x0 - tolerance && ix1 <= x1 + tolerance) {
      pieces.push({ text: item.text, left: ix0, right: ix1, top: iy0, bottom: iy1 })
      continue
    }
    // A run that crosses the box edge: keep the characters whose estimated centre is inside.
    const chars = [...item.text]
    const step = (ix1 - ix0) / chars.length
    let first = -1
    let last = -1
    chars.forEach((_, index) => {
      const centre = ix0 + step * (index + 0.5)
      if (centre < x0 || centre > x1) return
      if (first < 0) first = index
      last = index
    })
    if (first < 0) continue
    pieces.push({ text: chars.slice(first, last + 1).join(''), left: ix0 + step * first, right: ix0 + step * (last + 1), top: iy0, bottom: iy1 })
  }
  if (pieces.length === 0) return ''
  const centres = pieces.map((piece) => (piece.top + piece.bottom) / 2)
  const tallest = Math.max(...pieces.map((piece) => piece.bottom - piece.top))
  if (Math.max(...centres) - Math.min(...centres) > 0.6 * tallest) return null
  pieces.sort((left, right) => left.left - right.left)
  let result = ''
  let previous: (typeof pieces)[number] | undefined
  for (const piece of pieces) {
    const gap = previous ? piece.left - previous.right : 0
    if (previous && gap > 0.15 * Math.min(previous.bottom - previous.top, piece.bottom - piece.top) && !/\s$/u.test(result) && !/^\s/u.test(piece.text)) result += ' '
    result += piece.text
    previous = piece
  }
  return result.replace(/\s+/gu, ' ').trim()
}

/**
 * Accept the layer text only when it reads like prose and the parser output is
 * an in-order remnant of it (at least 85% of its letters and digits found in
 * order, with the layer at least 1.5 times longer).
 */
export function confirmsFragment(original: string, layerText: string): boolean {
  if (!layerText || /[�\p{Co}\p{Cc}]/u.test(layerText)) return false
  const words = layerText.split(/\s+/u).filter((token) => /\p{L}/u.test(token))
  if (words.length < 3) return false
  const lengths = words.map((word) => letters(word).length)
  if (lengths.filter((length) => length === 1).length / words.length > 0.35) return false
  if (lengths.reduce((sum, length) => sum + length, 0) / words.length < 3) return false
  const source = alphanumerics(original)
  const target = alphanumerics(layerText)
  if (source.length === 0 || target.length < 1.5 * source.length) return false
  let matched = 0
  let cursor = 0
  for (const char of source) {
    const found = target.indexOf(char, cursor)
    if (found < 0) continue
    matched += 1
    cursor = found + 1
  }
  return matched >= 0.85 * source.length
}

/** Decide every candidate against the text layer. Pages without layer data leave their candidates unresolved. */
export function planTextLayerRepairs(candidates: readonly TextLayerCandidate[], pages: readonly TextLayerPage[]): TextLayerRepairReport {
  const byPage = new Map(pages.map((page) => [page.pageIndex, page.items]))
  const repairs: TextLayerRepair[] = []
  const unresolved: TextLayerCandidate[] = []
  for (const candidate of candidates) {
    const items = byPage.get(candidate.pageIndex)
    const layerText = items ? textInBox(items, candidate.bbox) : null
    if (layerText && confirmsFragment(candidate.content, layerText)) {
      repairs.push({ pageIndex: candidate.pageIndex, bbox: candidate.bbox, original: candidate.content, replacement: layerText })
    } else {
      unresolved.push(candidate)
    }
  }
  return { version: TEXT_LAYER_REPAIR_VERSION, repairs, unresolved }
}

/**
 * Apply repairs to a parsed layout and its Markdown together. A repair whose
 * text cannot be located exactly once in the Markdown is dropped (and moved to
 * `unresolved`) so that the two artifacts never disagree.
 */
export function applyTextLayerRepairs(
  layout: unknown,
  markdown: string,
  report: TextLayerRepairReport
): { layout: unknown; markdown: string; report: TextLayerRepairReport } {
  const clone = structuredClone(layout)
  const refs = collectSpans(clone)
  const applied: TextLayerRepair[] = []
  const unresolved = [...report.unresolved]
  let nextMarkdown = markdown
  for (const repair of report.repairs) {
    const ref = refs.find((candidate) => candidate.candidate.pageIndex === repair.pageIndex &&
      candidate.candidate.content === repair.original && sameBox(candidate.candidate.bbox, repair.bbox))
    const patched = ref ? replaceInMarkdown(nextMarkdown, repair, ref.previous) : null
    if (!ref || patched === null) {
      unresolved.push(ref?.candidate ?? { pageIndex: repair.pageIndex, pageSize: [0, 0], bbox: repair.bbox, content: repair.original })
      continue
    }
    ref.span.content = repair.replacement
    nextMarkdown = patched
    applied.push(repair)
  }
  return { layout: clone, markdown: nextMarkdown, report: { version: TEXT_LAYER_REPAIR_VERSION, repairs: applied, unresolved } }
}

function replaceInMarkdown(markdown: string, repair: TextLayerRepair, previous: string): string | null {
  const positions = occurrences(markdown, repair.original)
  // An interrupted earlier repair may have published the Markdown but not the layout.
  if (positions.length === 0 && occurrences(markdown, escapeMarkdownText(repair.replacement, false)).length === 1) return markdown
  let index = positions.length === 1 ? positions[0]! : -1
  if (positions.length > 1 && previous) {
    // Disambiguate with the end of the preceding span of the same block.
    const tail = previous.slice(-24)
    const narrowed = positions.filter((position) => markdown.slice(Math.max(0, position - tail.length - 2), position).includes(tail))
    if (narrowed.length === 1) index = narrowed[0]!
  }
  if (index < 0) return null
  const end = index + repair.original.length
  const lineStart = index === 0 || markdown[index - 1] === '\n'
  let replacement = escapeMarkdownText(repair.replacement, lineStart)
  let after = markdown.slice(end)
  // The parser joins a hyphenated line break; do the same for a repaired line ending in a hyphen.
  if (/[-­‐]$/u.test(replacement) && /^ \p{Ll}/u.test(after)) {
    replacement = replacement.slice(0, -1)
    after = after.slice(1)
  }
  return markdown.slice(0, index) + replacement + after
}

function occurrences(text: string, search: string): number[] {
  const result: number[] = []
  for (let index = text.indexOf(search); index >= 0; index = text.indexOf(search, index + 1)) {
    const before = text[index - 1]
    const after = text[index + search.length]
    // Whole-span matches only: never splice into the middle of a word.
    if ((!before || !/[\p{L}\p{N}]/u.test(before)) && (!after || !/[\p{L}\p{N}]/u.test(after))) result.push(index)
  }
  return result
}

/** Layer text is plain prose; keep it from being read as Markdown, HTML or math. */
export function escapeMarkdownText(text: string, lineStart: boolean): string {
  // Brackets stay literal (citation markers such as `[60]`); only a link-forming `](`/`][` is broken up.
  let escaped = text.replace(/[\\`*_$]/gu, (char) => `\\${char}`).replace(/\](?=[([])/gu, '\\]').replace(/</gu, '&lt;')
  if (lineStart) escaped = escaped.replace(/^(\s*\d+)([.)])/u, '$1\\$2').replace(/^(\s*)([#>+=-])/u, '$1\\$2')
  return escaped
}

function collectSpans(layout: unknown): SpanRef[] {
  const pages = asObject(layout)?.pdf_info
  if (!Array.isArray(pages)) return []
  const refs: SpanRef[] = []
  pages.forEach((pageValue, pageOrder) => {
    const page = asObject(pageValue)
    if (!page) return
    const pageIndex = typeof page.page_idx === 'number' ? page.page_idx : pageOrder
    const size = Array.isArray(page.page_size) && page.page_size.length >= 2 ? page.page_size : [0, 0]
    const pageSize: [number, number] = [Number(size[0]) || 0, Number(size[1]) || 0]
    const visit = (blockValue: unknown): void => {
      const block = asObject(blockValue)
      if (!block) return
      if (Array.isArray(block.blocks)) block.blocks.forEach(visit)
      if (!Array.isArray(block.lines) || block.lines_deleted === true) return
      const blockBox = toBbox(block.bbox)
      let previous = ''
      for (const lineValue of block.lines) {
        const line = asObject(lineValue)
        const spans = line?.spans
        if (!Array.isArray(spans)) continue
        const lineBox = toBbox(line!.bbox)
        // A paragraph merged across pages keeps the next page's lines in this block.
        const owner = !blockBox || !lineBox || containsCenter(blockBox, lineBox)
          ? { pageIndex, pageSize }
          : continuationPage(pages, pageOrder, lineBox)
        for (const spanValue of spans) {
          const span = asObject(spanValue)
          if (!span || span.type !== 'text' || typeof span.content !== 'string') continue
          const bbox = toBbox(span.bbox)
          if (owner && bbox && isFragmentedText(span.content)) {
            refs.push({ candidate: { ...owner, bbox, content: span.content }, span, previous })
          }
          if (span.content.trim()) previous = span.content
        }
      }
    }
    if (Array.isArray(page.para_blocks)) page.para_blocks.forEach(visit)
  })
  return refs
}

/** The next page, when one of its `lines_deleted` blocks covers the line. Null when the line's page is unknown. */
function continuationPage(pages: unknown[], pageOrder: number, line: TextLayerBbox): { pageIndex: number; pageSize: [number, number] } | null {
  const next = asObject(pages[pageOrder + 1])
  if (!next || !Array.isArray(next.para_blocks)) return null
  const covered = next.para_blocks.some((value: unknown) => {
    const block = asObject(value)
    const box = toBbox(block?.bbox)
    return block?.lines_deleted === true && box !== null && containsCenter(box, line)
  })
  if (!covered) return null
  const size = Array.isArray(next.page_size) && next.page_size.length >= 2 ? next.page_size : [0, 0]
  return { pageIndex: typeof next.page_idx === 'number' ? next.page_idx : pageOrder + 1, pageSize: [Number(size[0]) || 0, Number(size[1]) || 0] }
}

function containsCenter(container: TextLayerBbox, box: TextLayerBbox): boolean {
  const x = (box[0] + box[2]) / 2
  const y = (box[1] + box[3]) / 2
  return x >= container[0] && x <= container[2] && y >= container[1] && y <= container[3]
}

function sameBox(left: TextLayerBbox, right: TextLayerBbox): boolean {
  return left.every((value, index) => Math.abs(value - right[index]!) < 0.01)
}

function letters(text: string): string {
  return text.replace(/[^\p{L}]/gu, '')
}

function alphanumerics(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null
}

function toBbox(value: unknown): TextLayerBbox | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) return null
  return value as TextLayerBbox
}
