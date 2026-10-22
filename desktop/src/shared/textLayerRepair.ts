/**
 * Repair parser text spans that lost most of their glyphs, using the PDF's own
 * text layer. MinerU sometimes recognises a line from a box clipped to the
 * ascender band, which keeps only letters such as `d h f l` and drops the
 * rest. The PDF text layer of the same box still holds the real words.
 *
 * Some PDFs instead make MinerU mark ordinary letters as sub/superscripts
 * (`Learnin<sub>g</sub>`) or drop descender letters (`o erator`). In a
 * document that shows this, every text span is compared with the text layer;
 * sub/superscripts are rebuilt from the layer's own geometry (smaller runs off
 * the line's baseline), so real ones such as `x<sub>i</sub>` or `<sup>*</sup>`
 * stay marked.
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
  /** `fragment`: only scattered letters left; `compare`: any span of a document with script noise. Absent in v1 reports. */
  kind?: 'fragment' | 'compare'
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
  /** Preceding span of the same block (any type, read at apply time so earlier repairs count). */
  previous: Record<string, unknown> | null
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

const SCRIPT_TAG = /<(sub|sup)>([^<]*)<\/\1>/gu

/** Ordinary letters wrapped as scripts inside or right after a word, e.g. `Learnin<sub>g</sub>` or `<sub>an</sub>d`. */
function spuriousScripts(content: string): number {
  let count = 0
  for (const match of content.matchAll(SCRIPT_TAG)) {
    const before = content[match.index - 1] ?? ''
    const after = content[match.index + match[0].length] ?? ''
    if (/^[\p{Ll}\s.,-]+$/u.test(match[2]!) && /\p{Ll}/u.test(match[2]!) && (/\p{L}/u.test(before) || /\p{L}/u.test(after))) count += 1
  }
  return count
}

/**
 * Candidate `text` spans of a MinerU layout (`pdf_info[].para_blocks`, including
 * nested blocks): fragmented lines, plus every span when at least 8 spans carry
 * two or more letter-only scripts glued to words.
 */
export function findTextLayerCandidates(layout: unknown): TextLayerCandidate[] {
  const refs = collectSpans(layout)
  const noisy = refs.filter((ref) => spuriousScripts(ref.candidate.content) >= 2).length >= 8
  return refs.flatMap((ref): TextLayerCandidate[] => isFragmentedText(ref.candidate.content)
    ? [{ ...ref.candidate, kind: 'fragment' as const }]
    : noisy ? [{ ...ref.candidate, kind: 'compare' as const }] : [])
}

interface LinePiece { text: string; left: number; right: number; top: number; bottom: number }

/** Text of the layer items that sit on the box's line, in left-to-right order. Null when the box spans several lines. */
export function textInBox(items: readonly TextLayerItem[], bbox: TextLayerBbox): string | null {
  const pieces = lineInBox(items, bbox)
  return pieces && joinPieces(pieces, () => null)
}

/**
 * Like `textInBox`, with `<sub>`/`<sup>` around runs that are smaller than the
 * line's main run and sit off its baseline in the PDF.
 */
export function markedTextInBox(items: readonly TextLayerItem[], bbox: TextLayerBbox): string | null {
  const pieces = lineInBox(items, bbox)
  if (!pieces || pieces.length === 0) return pieces && ''
  const main = pieces.reduce((widest, piece) => piece.right - piece.left > widest.right - widest.left ? piece : widest)
  const height = main.bottom - main.top
  const baseline = main.top + 0.8 * height
  return joinPieces(pieces, (piece) => {
    const pieceHeight = piece.bottom - piece.top
    const shift = piece.top + 0.8 * pieceHeight - baseline
    if (pieceHeight > 0.9 * height || Math.abs(shift) < 0.12 * height) return null
    return shift < 0 ? 'sup' : 'sub'
  })
}

function joinPieces(pieces: LinePiece[], script: (piece: LinePiece) => 'sub' | 'sup' | null): string {
  let result = ''
  let previous: LinePiece | undefined
  for (const piece of pieces) {
    const gap = previous ? piece.left - previous.right : 0
    if (previous && gap > 0.15 * Math.min(previous.bottom - previous.top, piece.bottom - piece.top) && !/\s$/u.test(result) && !/^\s/u.test(piece.text)) result += ' '
    const kind = script(piece)
    result += kind ? `<${kind}>${piece.text.trim()}</${kind}>` : piece.text
    previous = piece
  }
  return result.replace(/\s+/gu, ' ').trim()
}

function lineInBox(items: readonly TextLayerItem[], bbox: TextLayerBbox): LinePiece[] | null {
  const [x0, y0, x1, y1] = bbox
  const boxHeight = y1 - y0
  const pieces: LinePiece[] = []
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
  if (pieces.length === 0) return pieces
  const centres = pieces.map((piece) => (piece.top + piece.bottom) / 2)
  const tallest = Math.max(...pieces.map((piece) => piece.bottom - piece.top))
  if (Math.max(...centres) - Math.min(...centres) > 0.6 * tallest) return null
  return pieces.sort((left, right) => left.left - right.left)
}

/**
 * The layer line that replaces a span of a noisy document, or null to keep it.
 * Replace when the letters equal the parser's but the scripts differ, or when
 * the parser dropped a few letters (`o erator` for `operator`): every parser
 * letter found in order, at most a quarter more in the layer. Layer text before
 * or after the parser's first/last letter is kept only when it completes that
 * word; a separate word or a script (e.g. an equation's own superscript caught
 * by the box) is trimmed off.
 */
export function compareWithLayer(original: string, marked: string): string | null {
  if (!marked || /[�\p{Co}\p{Cc}]/u.test(marked)) return null
  const source = alphanumerics(stripScripts(original))
  if (!source) return null
  const lead = /^[^\p{L}\p{N}]*/u.exec(stripScripts(original).trimStart())![0].replace(/\s+/gu, '')
  const trimmed = trimLayerExtras(marked, source, lead)
  if (!trimmed) return null
  const target = alphanumerics(stripScripts(trimmed))
  if (target === source) return scriptSignature(original) !== scriptSignature(trimmed) ? trimmed : null
  return target.length > source.length && target.length <= 1.25 * source.length + 4 ? trimmed : null
}

function trimLayerExtras(marked: string, source: string, lead: string): string | null {
  const chars: Array<{ char: string; script: boolean; at: number }> = []
  let script = false
  for (let index = 0; index < marked.length;) {
    const tag = /^<(\/?)su[bp]>/u.exec(marked.slice(index))
    if (tag) { script = tag[1] !== '/'; index += tag[0].length; continue }
    chars.push({ char: marked[index]!, script, at: index })
    index += 1
  }
  const alnum = chars.map((char, index) => ({ ...char, index })).filter((char) => /[\p{L}\p{N}]/u.test(char.char))
  let cursor = 0
  let first = -1
  let last = -1
  for (const char of source) {
    while (cursor < alnum.length && alnum[cursor]!.char.toLowerCase() !== char) cursor += 1
    if (cursor >= alnum.length) return null
    if (first < 0) first = cursor
    last = cursor
    cursor += 1
  }
  // Extend over letters glued to the matched ones (same word, same script state).
  const glued = (from: number, step: -1 | 1): number => {
    let index = alnum[from]!.index
    while (chars[index + step] && /[\p{L}\p{N}]/u.test(chars[index + step]!.char) && chars[index + step]!.script === chars[index]!.script) index += step
    return index
  }
  const start = glued(first, -1)
  const end = glued(last, 1)
  if (alnum[first]!.index - start > 2 || end - alnum[last]!.index > 2) return null
  let from = chars[start]!.at
  let to = chars[end]!.at + 1
  // Keep the tags around a matched script; drop leading/trailing words and scripts outside the match.
  while (/<su[bp]>$/u.test(marked.slice(0, from))) from -= 5
  // Leading punctuation that the parser's span also starts with, e.g. `(b)` or `. The`.
  if (lead) {
    let back = from
    let punctuation = ''
    while (back > 0 && punctuation.length < lead.length) {
      const tag = /<\/?su[bp]>$/u.exec(marked.slice(0, back))
      if (tag) { back -= tag[0].length; continue }
      const char = marked[back - 1]!
      if (/[\p{L}\p{N}]/u.test(char)) break
      if (!/\s/u.test(char)) punctuation = char + punctuation
      back -= 1
    }
    if (punctuation === lead) from = back
  }
  while (/^<\/su[bp]>/u.test(marked.slice(to))) to += 6
  // Punctuation glued to the kept text stays (e.g. a closing period).
  while (to < marked.length && /^[^\s<\p{L}\p{N}]/u.test(marked.slice(to))) to += 1
  return marked.slice(from, to).trim()
}

function stripScripts(text: string): string {
  return text.replace(SCRIPT_TAG, '$2')
}

function scriptSignature(text: string): string {
  return JSON.stringify([...text.matchAll(SCRIPT_TAG)].map((match) => [match[1], alphanumerics(match[2]!)]))
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
    const marked = items ? markedTextInBox(items, candidate.bbox) : null
    const replacement = marked === null ? null : candidate.kind === 'compare'
      ? compareWithLayer(candidate.content, marked)
      : confirmsFragment(candidate.content, stripScripts(marked)) ? marked : null
    if (replacement) {
      repairs.push({ pageIndex: candidate.pageIndex, bbox: candidate.bbox, original: candidate.content, replacement })
    } else if (candidate.kind !== 'compare') {
      // Compared spans that already match the layer are simply correct.
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

function replaceInMarkdown(markdown: string, repair: TextLayerRepair, previousSpan: Record<string, unknown> | null): string | null {
  const previous = typeof previousSpan?.content === 'string' ? previousSpan.content : ''
  // After a hyphenated line break the parser glues this span to the previous word.
  const glued = previousSpan?.type === 'text' && /[-­‐]$/u.test(previous.trimEnd())
  // An interrupted earlier repair may have published the Markdown but not the layout.
  if (spanForms(repair.original).every((form) => occurrences(markdown, form).length === 0) &&
    occurrences(markdown, escapeMarkdownText(repair.replacement, false)).length === 1) return markdown
  const found = locateSpan(markdown, repair.original, previous, glued)
  if (!found) return null
  const { index, length, joined } = found
  const lineStart = index === 0 || markdown[index - 1] === '\n'
  let replacement = escapeMarkdownText(repair.replacement, lineStart)
  // The parser already joined this hyphenated line break.
  if (joined) replacement = replacement.replace(/[-\u00ad\u2010]$/u, '')
  const end = index + length
  let after = markdown.slice(end)
  // The parser joins a hyphenated line break; do the same for a repaired line ending in a hyphen.
  if (/[-­‐]$/u.test(replacement) && /^ \p{Ll}/u.test(after)) {
    replacement = replacement.slice(0, -1)
    after = after.slice(1)
  }
  return markdown.slice(0, index) + replacement + after
}

/** MinerU writes `*` and `_` escaped in Markdown, and joins a line that ends in a hyphen with the next one. */
function spanForms(content: string): string[] {
  return [...new Set([content, content.replace(/[*]/gu, '\\$&'), content.replace(/[*_]/gu, '\\$&')])]
}

function locateSpan(markdown: string, original: string, previous: string, glued: boolean): { index: number; length: number; joined: boolean } | null {
  const tail = previous.replace(/[-­‐]$/u, '').slice(-12)
  const pick = (positions: number[]): number => {
    if (positions.length === 1) return positions[0]!
    // Disambiguate with the end of the preceding span of the same block.
    const narrowed = tail ? positions.filter((position) => markdown.slice(Math.max(0, position - tail.length - 6), position).includes(tail)) : []
    return narrowed.length === 1 ? narrowed[0]! : -1
  }
  for (const form of spanForms(original)) {
    const index = pick(occurrences(markdown, form, false, glued))
    if (index >= 0) return { index, length: form.length, joined: false }
    const stem = form.replace(/[-\u00ad\u2010]$/u, '')
    if (stem === form || !stem) continue
    const joined = pick(occurrences(markdown, stem, true, glued))
    if (joined >= 0) return { index: joined, length: stem.length, joined: true }
  }
  return null
}

function occurrences(text: string, search: string, continued = false, glued = false): number[] {
  const result: number[] = []
  for (let index = text.indexOf(search); index >= 0; index = text.indexOf(search, index + 1)) {
    const before = text[index - 1]
    const after = text[index + search.length]
    // Whole-span matches only: never splice into the middle of a word. A joined hyphenated span continues with a lowercase letter.
    const endOk = continued ? Boolean(after && /\p{Ll}/u.test(after)) : !after || !/[\p{L}\p{N}]/u.test(after) || search.endsWith('>')
    if ((!before || !/[\p{L}\p{N}]/u.test(before) || search.startsWith('<') || glued) && endOk) result.push(index)
  }
  return result
}

/** Layer text is plain prose with optional `<sub>`/`<sup>`; keep the rest from being read as Markdown, HTML or math. */
export function escapeMarkdownText(text: string, lineStart: boolean): string {
  // Brackets stay literal (citation markers such as `[60]`); only a link-forming `](`/`][` is broken up.
  let escaped = text.split(/(<\/?su[bp]>)/u).map((part, index) => index % 2 === 1 ? part
    : part.replace(/[\\`*_$]/gu, (char) => `\\${char}`).replace(/\](?=[([])/gu, '\\]').replace(/</gu, '&lt;')).join('')
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
      let previous: Record<string, unknown> | null = null
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
          if (!span || typeof span.content !== 'string' || !span.content.trim()) continue
          const bbox = toBbox(span.bbox)
          if (span.type === 'text' && owner && bbox) refs.push({ candidate: { ...owner, bbox, content: span.content }, span, previous })
          previous = span
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
