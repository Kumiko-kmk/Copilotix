import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { ReaderBlock } from '../core/readerDocument'
import { readerReferenceSections } from './readerReferenceSections'

/**
 * In-text citations resolved against the paper's own reference list. Entirely local: an
 * entry is only ever taken from the parsed References section, and a marker that does not
 * resolve to exactly the cited entries is left alone instead of guessed.
 */
export interface ReferenceEntry {
  /** `n12` for numbered lists, `a5` (reading order) for author-year lists. */
  id: string
  number?: number
  blockIndex: number
  /** Plain entry text without its list marker. */
  text: string
  /** Author-year lists: normalized words of the first author, and year tokens (`2021a`). */
  firstAuthor?: string[]
  years?: string[]
  normalized?: string
}

export interface CitationIndex {
  style: 'numeric' | 'author-year' | null
  entries: ReferenceEntry[]
  byNumber: Map<number, ReferenceEntry>
  /** Blocks of the reference list itself; citations are not looked for there. */
  referenceBlocks: Set<number>
  /** Numbered papers that cite with superscripts instead of brackets. */
  superscripts: boolean
}

export interface CitationMatch {
  start: number
  end: number
  entries: ReferenceEntry[]
  /** Numbers inside a cited range whose entry the parsed list lacks (garbled in the PDF). */
  missing: number[]
}

export interface ResolvedCitation { entries: ReferenceEntry[]; missing: number[] }

type MdNode = { type: string; value?: string; children?: MdNode[]; ordered?: boolean | null; start?: number | null; position?: { start: { offset?: number } } }
interface Segment { blockIndex: number; text: string; number?: number }

const parser = unified().use(remarkParse)
const BLOCK_CONTAINERS = new Set(['root', 'list', 'listItem', 'blockquote', 'table', 'tableRow'])
const NUMBERED_START = /^\s*(?:\[(\d{1,4})\]|(\d{1,4})\s*[.)]\s*(?=\S)|(\d{1,4})\s+(?=\p{Lu}))/u
const YEAR = String.raw`(?:19|20)\d{2}[a-z]?`
const ENTRY_YEAR = /(?<![\d.:/-])((?:19|20)\d{2})([a-z])?(?![\d]|\.\d)/gu
const DASH = String.raw`[–—\-−~～]`
const NUMBER_LIST = String.raw`\d{1,4}(?:\s*${DASH}\s*\d{1,4})?(?:\s*[,，;；]\s*\d{1,4}(?:\s*${DASH}\s*\d{1,4})?)*`
const BRACKET_CITATION = new RegExp(String.raw`[\[［【]\s*(${NUMBER_LIST})\s*[\]］】]`, 'gu')
const SUPERSCRIPT_CITATION = new RegExp(String.raw`^\s*(${NUMBER_LIST})\s*[,.]?\s*$`, 'u')
const MATH_BEFORE = /[∈∉=<>≤≥×+*/^_]\s*$/u
// Latin letters only: a Chinese translation writes 「Li等，2018」 with no space after the name.
const NAME = String.raw`\p{Lu}[\p{Script=Latin}\p{M}'’\-]*\p{Script=Latin}`
const NAMES = String.raw`(?:${NAME}\s+){0,2}${NAME}`
const TAIL = String.raw`\s+et\s+al\.?|\s*等人?|\s*(?:and|&|和|与|及)\s*(${NAME})`
const YEARS = String.raw`${YEAR}(?:\s*[,，]\s*${YEAR})*`
const NARRATIVE = new RegExp(String.raw`(?<![\p{Script=Latin}\p{M}])(${NAMES})(?:${TAIL})?\s*[(（\[]\s*(${YEARS})\s*[)）\]]`, 'gu')
const PARENTHETICAL_GROUP = /[(（]([^()（）]{4,600})[)）]/gu
const PARENTHETICAL_PART = new RegExp(String.raw`(?<![\p{Script=Latin}\p{M}])(${NAMES})(?:${TAIL})?\s*[,，]?\s*(${YEARS})\s*$`, 'u')
const MAX_RANGE = 50
const cache = new WeakMap<readonly ReaderBlock[], CitationIndex>()

export function buildCitationIndex(blocks: readonly ReaderBlock[]): CitationIndex {
  const cached = cache.get(blocks)
  if (cached) return cached
  const index = createIndex(blocks)
  cache.set(blocks, index)
  return index
}

function createIndex(blocks: readonly ReaderBlock[]): CitationIndex {
  const sections = readerReferenceSections(blocks)
  const segments = [...sections].flatMap(blockIndex => blockSegments(blocks[blockIndex]!.markdown, blockIndex))
  const numbered = segments.filter(segment => segmentNumber(segment) !== undefined).length
  let entries: ReferenceEntry[] = []
  let style: CitationIndex['style'] = null
  if (numbered >= 3 && numbered >= segments.length / 2) {
    entries = numberedEntries(segments, false)
    style = 'numeric'
  } else if (segments.length >= 3) {
    entries = authorYearEntries(segments)
    style = entries.length >= 3 ? 'author-year' : null
  }
  // Journals such as Nature print the list without a heading: a numbered run from 1 near the end.
  if (!style) {
    entries = headlessEntries(blocks)
    style = entries.length >= 5 ? 'numeric' : null
  }
  if (!style) entries = []
  const referenceBlocks = new Set([...sections, ...entries.map(entry => entry.blockIndex)])
  const byNumber = new Map<number, ReferenceEntry>()
  for (const entry of entries) if (entry.number !== undefined && !byNumber.has(entry.number)) byNumber.set(entry.number, entry)
  const index: CitationIndex = { style, entries, byNumber, referenceBlocks, superscripts: false }
  if (style === 'numeric') index.superscripts = prefersSuperscripts(blocks, referenceBlocks, index)
  return index
}

const segmentCache = new Map<string, Segment[]>()
/** Cached by text and position: an edit elsewhere does not re-parse the reference list. */
function blockSegments(markdown: string, blockIndex: number): Segment[] {
  const key = blockIndex + '\u0000' + markdown
  let segments = segmentCache.get(key)
  if (!segments) {
    segments = parseBlockSegments(markdown, blockIndex)
    if (segmentCache.size >= 4_000) segmentCache.delete(segmentCache.keys().next().value!)
    segmentCache.set(key, segments)
  }
  return segments
}

/** Plain text of each list item (with its number), or of the whole block. */
function parseBlockSegments(markdown: string, blockIndex: number): Segment[] {
  const tree = parser.parse(markdown) as MdNode
  const result: Segment[] = []
  const loose: string[] = []
  const flush = (): void => {
    const text = loose.join(' ').trim()
    if (text) result.push({ blockIndex, text })
    loose.length = 0
  }
  for (const node of tree.children ?? []) {
    if (node.type === 'heading') continue
    if (node.type === 'list' && node.ordered) {
      flush()
      for (const [offset, item] of (node.children ?? []).entries()) {
        const text = plainText(item).trim()
        // The item's own number: Markdown renumbers lists, but two-column pages run out of order.
        const written = /^\s*(\d{1,4})[.)]/u.exec(markdown.slice(item.position?.start.offset ?? markdown.length))?.[1]
        if (text) result.push({ blockIndex, text, number: written ? Number(written) : (node.start ?? 1) + offset })
      }
    } else loose.push(plainText(node))
  }
  flush()
  return result
}

function plainText(node: MdNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? ''
  if (node.type === 'html') return (node.value ?? '').replace(/<[^>]*>/gu, '')
  if (node.type === 'break') return ' '
  return (node.children ?? []).map(plainText).join(BLOCK_CONTAINERS.has(node.type) ? ' ' : '')
}

function segmentNumber(segment: Segment): number | undefined {
  if (segment.number !== undefined) return segment.number
  const match = NUMBERED_START.exec(segment.text)
  const value = match ? Number(match[1] ?? match[2] ?? match[3]) : NaN
  return Number.isFinite(value) ? value : undefined
}

function stripNumber(segment: Segment): string {
  return segment.number !== undefined ? segment.text : segment.text.replace(NUMBERED_START, '').trim()
}

/**
 * Each number starts one entry; two-column pages may list them out of order. Other text continues
 * the previous entry (a page break, a wrapped line). Without a heading only reference-like
 * paragraphs count, text continues an entry only while it is unfinished, and the list ends after
 * a stretch of ordinary text.
 */
function numberedEntries(segments: Segment[], headless: boolean): ReferenceEntry[] {
  const entries: ReferenceEntry[] = []
  const seen = new Set<number>()
  let current: ReferenceEntry | null = null
  let previousWasEntry = false
  let idle = 0
  const open = (number: number, blockIndex: number, text: string): ReferenceEntry => {
    const entry: ReferenceEntry = { id: 'n' + number, number, blockIndex, text }
    entries.push(entry)
    seen.add(number)
    return entry
  }
  for (const segment of segments) {
    const number = segmentNumber(segment)
    const max = Math.max(0, ...seen)
    if (number !== undefined && number >= 1 && !seen.has(number) && number <= (seen.size ? max + 30 : 3) &&
      // An entry broken by a page has no year yet; the expected next number only needs authors.
      (!headless || referenceLike(segment.text) || (number === max + 1 && authorLike(segment.text)))) {
      current = open(number, segment.blockIndex, stripNumber(segment))
      // MinerU sometimes merges consecutive entries into one paragraph.
      for (;;) {
        const next = current.number! + 1
        const split = seen.has(next) ? null : new RegExp(String.raw`(?:^|\s)(?:\[${next}\]|${next}\.\s?(?=\p{Lu}))\s*`, 'u').exec(current.text)
        if (!split || split.index === 0) break
        const rest = current.text.slice(split.index + split[0].length).trim()
        current.text = current.text.slice(0, split.index).trim()
        current = open(next, segment.blockIndex, rest)
      }
      previousWasEntry = true
      idle = 0
    } else if (current && (!headless || (previousWasEntry && !/[.)]\s*$/u.test(current.text)))) {
      current.text += ' ' + segment.text
    } else {
      previousWasEntry = false
      if (headless && entries.length && ++idle > 15) break
    }
  }
  return entries
}

/** All paragraphs from the first reference-like item numbered 1 that yields the longest list. */
function headlessEntries(blocks: readonly ReaderBlock[]): ReferenceEntry[] {
  const segments = blocks.flatMap((_, index) => contentSegments(blocks, index))
  let best: ReferenceEntry[] = []
  for (const [start, segment] of segments.entries()) {
    if (segmentNumber(segment) !== 1 || !referenceLike(segment.text)) continue
    const entries = numberedEntries(segments.slice(start), true)
    if (entries.length > best.length) best = entries
  }
  return best
}

function contentSegments(blocks: readonly ReaderBlock[], index: number): Segment[] {
  const block = blocks[index]
  return block && block.role === 'content' ? blockSegments(block.markdown, index) : []
}

function referenceLike(text: string): boolean {
  return /(?:19|20)\d{2}/u.test(text) && authorLike(text)
}

function authorLike(text: string): boolean {
  return /\bet al\b/u.test(text) || /\p{Lu}[\p{L}'’-]+,?\s+(?:\p{Lu}\.\s?-?)+/u.test(text) || /\p{Lu}[\p{L}'’-]+\s+\p{Lu}{1,3}[,.]/u.test(text)
}

function authorYearEntries(segments: Segment[]): ReferenceEntry[] {
  const entries: ReferenceEntry[] = []
  for (const segment of segments) {
    const current = entries.at(-1)
    const starts = /^\s*(?:(?:van|von|der|den|de|da|di|del|della|des|du|la|le|dos|d’|d')\s*)*\p{Lu}/u.test(segment.text)
    // A part without a year yet is the start of an entry broken by a page.
    if (current && (!starts || !current.years?.length)) {
      current.text += ' ' + segment.text
      describeAuthorYear(current)
      continue
    }
    if (!starts) continue
    const entry: ReferenceEntry = { id: 'a' + entries.length, blockIndex: segment.blockIndex, text: segment.text }
    describeAuthorYear(entry)
    entries.push(entry)
  }
  return entries.filter(entry => entry.years?.length)
}

function describeAuthorYear(entry: ReferenceEntry): void {
  const head = /^(.*?)(?:,|\s+and\s|\s*&|(?<!(?:^|\s)\p{Lu})\.(?:\s|$))/u.exec(entry.text)?.[1] ?? entry.text.slice(0, 60)
  entry.firstAuthor = words(head)
  entry.years = [...entry.text.matchAll(ENTRY_YEAR)].map(match => match[1]! + (match[2] ?? ''))
  entry.normalized = ' ' + words(entry.text).join(' ') + ' '
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\p{M}¨]/gu, '').replace(/’/gu, "'").toLowerCase()
}

function words(value: string): string[] {
  return normalize(value).match(/[\p{Script=Latin}'-]+/gu) ?? []
}

/** Footnote superscripts are common in bracket-cited papers; only trust them where brackets are absent. */
function prefersSuperscripts(blocks: readonly ReaderBlock[], referenceBlocks: Set<number>, index: CitationIndex): boolean {
  let brackets = 0
  let superscripts = 0
  for (const [blockIndex, block] of blocks.entries()) {
    if (block.role !== 'content' || referenceBlocks.has(blockIndex)) continue
    brackets += findNumericCitations(block.markdown.replace(/\\\[/gu, '['), index).length
    for (const match of block.markdown.matchAll(/<sup>([^<]*)<\/sup>/gu)) if (superscriptCitation(match[1]!, index)) superscripts += 1
  }
  return superscripts > brackets
}

export function findCitations(text: string, index: CitationIndex): CitationMatch[] {
  if (index.style === 'numeric') return findNumericCitations(text, index)
  if (index.style === 'author-year') return findAuthorYearCitations(text, index)
  return []
}

function findNumericCitations(text: string, index: CitationIndex): CitationMatch[] {
  const result: CitationMatch[] = []
  // A superscript-cited paper uses brackets for intervals such as [1, 2].
  if (index.superscripts) return result
  for (const match of text.matchAll(BRACKET_CITATION)) {
    if (MATH_BEFORE.test(text.slice(Math.max(0, match.index - 3), match.index))) continue
    if (/^[\^_(]/u.test(text.slice(match.index + match[0].length))) continue
    const resolved = resolveNumbers(match[1]!, index)
    if (resolved) result.push({ start: match.index, end: match.index + match[0].length, ...resolved })
  }
  return result
}

/** The entries of a superscript such as `1–4` or `6,7`, or null. */
export function superscriptCitation(text: string, index: CitationIndex): ResolvedCitation | null {
  const match = SUPERSCRIPT_CITATION.exec(text)
  return match ? resolveNumbers(match[1]!, index) : null
}

/** Numbers past the end of the list mean this is no citation; gaps inside it are reported, not guessed. */
function resolveNumbers(list: string, index: CitationIndex): ResolvedCitation | null {
  const numbers: number[] = []
  for (const part of list.split(/\s*[,，;；]\s*/u)) {
    const [from, to] = part.split(new RegExp(String.raw`\s*${DASH}\s*`, 'u')).map(Number)
    if (!from) return null
    if (to === undefined) { numbers.push(from); continue }
    if (!(to > from) || to - from > MAX_RANGE) return null
    for (let number = from; number <= to; number += 1) numbers.push(number)
  }
  const last = index.entries.at(-1)?.number ?? 0
  if (numbers.some(number => number > last)) return null
  const unique = [...new Set(numbers)]
  const entries = unique.flatMap(number => index.byNumber.get(number) ?? [])
  return entries.length ? { entries, missing: unique.filter(number => !index.byNumber.has(number)) } : null
}

function findAuthorYearCitations(text: string, index: CitationIndex): CitationMatch[] {
  const result: CitationMatch[] = []
  for (const match of text.matchAll(NARRATIVE)) {
    const entries = resolveAuthorYear(match[1]!, match[2], match[3]!, index)
    if (!entries) continue
    const start = match.index + nameOffset(match[1]!, entries[0]!)
    result.push({ start, end: match.index + match[0].length, entries, missing: [] })
  }
  for (const group of text.matchAll(PARENTHETICAL_GROUP)) {
    const inner = group[1]!
    const innerStart = group.index + group[0].indexOf(inner)
    if (result.some(item => item.start < innerStart + inner.length && item.end > innerStart)) continue
    let offset = 0
    for (const part of inner.split(/([;；])/u)) {
      const partStart = innerStart + offset
      offset += part.length
      if (part === ';' || part === '；') continue
      const match = PARENTHETICAL_PART.exec(part)
      if (!match) continue
      const entries = resolveAuthorYear(match[1]!, match[2], match[3]!, index)
      if (!entries) continue
      const end = partStart + match.index + match[0].trimEnd().length
      result.push({ start: partStart + match.index + nameOffset(match[1]!, entries[0]!), end, entries, missing: [] })
    }
  }
  return result.sort((left, right) => left.start - right.start)
}

function resolveAuthorYear(names: string, second: string | undefined, years: string, index: CitationIndex): ReferenceEntry[] | null {
  const surname = words(names).at(-1)
  if (!surname) return null
  const secondName = second ? words(second).at(-1) : undefined
  const entries: ReferenceEntry[] = []
  for (const year of years.split(/\s*[,，]\s*/u)) {
    const candidates = index.entries.filter(entry => entry.firstAuthor?.includes(surname) &&
      entry.years?.some(value => /[a-z]$/u.test(year) ? value === year : value.slice(0, 4) === year) &&
      (!secondName || entry.normalized?.includes(' ' + secondName + ' ')))
    if (candidates.length !== 1) return null
    entries.push(candidates[0]!)
  }
  return entries
}

/** Start the marked text at the cited name, extended over particles the entry also has ("De Lorenzis"). */
function nameOffset(names: string, entry: ReferenceEntry): number {
  const parts = [...names.matchAll(/\S+/gu)]
  let first = parts.length - 1
  while (first > 0 && entry.firstAuthor?.includes(words(parts[first - 1]![0]).at(-1) ?? '')) first -= 1
  return parts[first]?.index ?? 0
}

/** Author lines carry affiliation superscripts that look exactly like citations. */
export function looksLikeAuthorLine(textWithoutSuperscripts: string): boolean {
  const latin = textWithoutSuperscripts.match(/\p{Script=Latin}[\p{Script=Latin}'’\-.]*/gu)?.filter(word => !/^(?:and|und|et)$/u.test(word)) ?? []
  const han = textWithoutSuperscripts.match(/\p{Script=Han}/gu)?.length ?? 0
  if (latin.length < 2 || han > 4) return false
  return latin.filter(word => /^\p{Lu}/u.test(word)).length >= latin.length * 0.85
}

/** The same entry in the other reading view, when its text differs (a translated list). */
export function counterpartEntry(entry: ReferenceEntry, own: CitationIndex, other: CitationIndex | null): ReferenceEntry | null {
  if (!other || other.style !== own.style) return null
  const match = entry.number !== undefined
    ? other.byNumber.get(entry.number)
    : other.entries.length === own.entries.length ? other.entries.find(candidate => candidate.id === entry.id) : undefined
  if (!match) return null
  const compact = (value: string): string => value.replace(/\s+/gu, '')
  return compact(match.text) === compact(entry.text) ? null : match
}
