import { alignMarkdownBlocks, splitMarkdownBlocks, type AlignedMarkdownBlock } from './markdownBlocks'
import type { BlockMapping, TranslatedMarkdownBlock, TranslationProviderId } from './types'
import { prepareReaderMarkdown } from './standardMarkdown'
import type { ResolvedMarkdownEdits } from './markdownEdits'

export type ReaderBlockRole =
  | 'content'
  | 'page-header'
  | 'page-footer'
  | 'page-number'
  | 'footnote'
  | 'page-divider'

export interface ReaderBlock {
  role: ReaderBlockRole
  markdown: string
  annotationKey?: string
  text?: string
  mappingIds: string[]
  pageIndex?: number
  order: number
  fallbackProvider?: TranslationProviderId
  /** Content position in the parsed Markdown; the edit layer addresses blocks by it. */
  contentIndex?: number
  /** Unprepared block Markdown, as edited and saved. */
  source?: string
  /** The user's edit layer: `edited` for this view's text, `stale` when the translation predates the original. */
  edit?: { edited: boolean; stale: boolean }
  sourceChanged?: true
}

export interface ReaderDocumentBlocks {
  original: ReaderBlock[]
  translated: ReaderBlock[]
}

interface BoundaryBlock {
  block: ReaderBlock
  pageIndex: number
}

const HEADER_TYPES = new Set(['header', 'page_header'])
const FOOTER_TYPES = new Set(['footer', 'page_footer'])
const PAGE_NUMBER_TYPES = new Set(['page_number', 'page_num', 'page_count'])
const FOOTNOTE_TYPES = new Set(['footnote', 'page_footnote'])

export function buildReaderDocumentBlocks(
  markdown: string,
  translatedMarkdown: string,
  translatedBlocks: TranslatedMarkdownBlock[] | null,
  mappings: BlockMapping[]
): ReaderDocumentBlocks {
  const original = buildOriginalReaderBlocks(markdown, mappings)
  const translated = buildTranslatedReaderBlocks(markdown, translatedMarkdown, translatedBlocks, mappings)

  return { original, translated }
}

/** Mappings that align to Markdown content; page furniture is shown from the layout instead. */
export function readerContentMappings(mappings: readonly BlockMapping[]): BlockMapping[] {
  return mappings.filter((mapping) => supplementalRole(mapping) === null)
}

export function buildOriginalReaderBlocks(
  markdown: string,
  mappings: BlockMapping[],
  edits?: ResolvedMarkdownEdits | null
): ReaderBlock[] {
  const contentMappings = mappings.filter((mapping) => supplementalRole(mapping) === null)
  const originalContent = alignMarkdownBlocks(markdown, contentMappings)
  const byIndex = editsByIndex(edits)
  const content = byIndex ? originalContent.map((block, index) => {
    const edited = byIndex.get(index)?.original
    return edited === undefined ? block : { ...block, markdown: edited }
  }) : originalContent
  return applyReaderEdits(mergeReaderBlocks(content, mappings), edits, 'original')
}

export function buildTranslatedReaderBlocks(
  markdown: string,
  translatedMarkdown: string,
  translatedBlocks: TranslatedMarkdownBlock[] | null,
  mappings: BlockMapping[],
  edits?: ResolvedMarkdownEdits | null
): ReaderBlock[] {
  if (!translatedMarkdown) return []
  const contentMappings = mappings.filter((mapping) => supplementalRole(mapping) === null)
  const originalContent = alignMarkdownBlocks(markdown, contentMappings)
  const translatedContent = translatedMarkdown
    ? translatedBlocks
      ? remapTranslatedContent(translatedBlocks, originalContent)
      : reuseOriginalMapping(translatedMarkdown)
    : []
  if (translatedContent.length === 0) return []
  // Edits address source positions; a translation that cannot be matched to them is shown as is.
  if (translatedContent.length !== originalContent.length) return mergeReaderBlocks(translatedContent, mappings)
  const byIndex = editsByIndex(edits)
  const content = byIndex ? translatedContent.map((block, index) => {
    const edited = byIndex.get(index)?.translated
    return edited === undefined ? block : { ...block, markdown: edited }
  }) : translatedContent
  return applyReaderEdits(mergeReaderBlocks(content, mappings), edits, 'translated')
}

function editsByIndex(edits: ResolvedMarkdownEdits | null | undefined): Map<number, ResolvedMarkdownEdits['blocks'][number]> | null {
  return edits && (edits.blocks.length || edits.supplementalDeleted.length) ? new Map(edits.blocks.map((entry) => [entry.index, entry])) : null
}

/** Marks edited and stale blocks and drops deleted ones after numbering, so annotation keys stay put. */
function applyReaderEdits(blocks: ReaderBlock[], edits: ResolvedMarkdownEdits | null | undefined, view: 'original' | 'translated'): ReaderBlock[] {
  const byIndex = editsByIndex(edits)
  if (!byIndex) return blocks
  const hidden = new Set(edits!.supplementalDeleted.map((item) => `supplemental:${item.mappingId}`))
  const result: ReaderBlock[] = []
  for (const block of blocks) {
    if (block.annotationKey && hidden.has(block.annotationKey)) continue
    const entry = block.contentIndex === undefined ? undefined : byIndex.get(block.contentIndex)
    if (entry?.deleted) continue
    const edited = view === 'original' ? entry?.original !== undefined : entry?.translated !== undefined
    const stale = view === 'translated' && Boolean(entry?.stale)
    result.push(edited || stale ? { ...block, edit: { edited, stale } } : block)
  }
  return result
}

export function mergeReaderBlocks(
  contentBlocks: AlignedMarkdownBlock[],
  mappings: BlockMapping[]
): ReaderBlock[] {
  const mappingById = new Map(mappings.map((mapping) => [mapping.id, mapping]))
  const content = contentBlocks.map((block, sequence): ReaderBlock => ({
    role: 'content',
    markdown: prepareReaderMarkdown(block.markdown),
    annotationKey: `content:${sequence}`,
    mappingIds: block.mappingIds,
    order: sequence,
    contentIndex: sequence,
    source: block.markdown,
    ...(block.fallbackProvider ? { fallbackProvider: block.fallbackProvider } : {}),
    ...(block.sourceChanged ? { sourceChanged: true as const } : {})
  }))
  const pagesByContentIndex = contentBlocks.map((block) => contentBlockPages(block, mappingById))
  const firstContentByPage = new Map<number, number>()
  const lastContentByPage = new Map<number, number>()
  for (const [contentIndex, pages] of pagesByContentIndex.entries()) {
    for (const pageIndex of pages) {
      if (!firstContentByPage.has(pageIndex)) firstContentByPage.set(pageIndex, contentIndex)
      lastContentByPage.set(pageIndex, contentIndex)
    }
  }

  const supplementsByPage = new Map<number, ReaderBlock[]>()
  for (const mapping of mappings) {
    const role = supplementalRole(mapping)
    const text = mapping.sourceText.trim()
    if (!role || !text) continue
    const pageIndex = firstPageIndex(mapping)
    if (pageIndex === undefined) continue
    const supplement: ReaderBlock = {
      role,
      markdown: '',
      annotationKey: `supplemental:${mapping.id}`,
      text,
      mappingIds: [],
      pageIndex,
      order: mapping.order
    }
    const pageSupplements = supplementsByPage.get(pageIndex) ?? []
    pageSupplements.push(supplement)
    supplementsByPage.set(pageIndex, pageSupplements)
  }

  const lastOrderByPage = new Map<number, number>()
  for (const mapping of mappings) {
    for (const box of mapping.boxes) {
      const current = lastOrderByPage.get(box.pageIndex)
      if (current === undefined || mapping.order > current) {
        lastOrderByPage.set(box.pageIndex, mapping.order)
      }
    }
  }
  const boundaries = new Map<number, BoundaryBlock[]>()
  for (const [pageIndex, lastOrder] of [...lastOrderByPage].sort((left, right) => left[0] - right[0])) {
    const pageSupplements = (supplementsByPage.get(pageIndex) ?? [])
      .filter((block) => block.role !== 'page-number')
      .sort((left, right) => left.order - right.order)
    const headers = pageSupplements.filter((block) => block.role === 'page-header')
    const tails = pageSupplements.filter((block) => block.role !== 'page-header')
    const firstContentIndex = firstContentByPage.get(pageIndex)
    const lastContentIndex = lastContentByPage.get(pageIndex)
    if (firstContentIndex !== undefined) {
      const previousPageLastContent = [...lastContentByPage]
        .filter(([candidatePage]) => candidatePage < pageIndex)
        .sort((left, right) => right[0] - left[0])[0]?.[1]
      addBoundaryBlocks(
        boundaries,
        previousPageLastContent === undefined ? 0 : previousPageLastContent + 1,
        pageIndex,
        headers
      )
    }
    const pageEndBlocks: ReaderBlock[] = [
      ...tails,
      {
        role: 'page-divider',
        markdown: '',
        text: '第 ' + String(pageIndex + 1) + ' 页',
        mappingIds: [],
        pageIndex,
        order: lastOrder + 0.75
      }
    ]
    if (lastContentIndex !== undefined) {
      addBoundaryBlocks(boundaries, lastContentIndex + 1, pageIndex, pageEndBlocks)
    } else {
      const boundary = boundaryForUnmappedPage(pageIndex, pagesByContentIndex, content.length)
      addBoundaryBlocks(boundaries, boundary, pageIndex, [...headers, ...pageEndBlocks])
    }
  }

  const result: ReaderBlock[] = []
  for (let boundary = 0; boundary <= content.length; boundary += 1) {
    const additions = (boundaries.get(boundary) ?? [])
      .sort((left, right) => left.pageIndex - right.pageIndex || left.block.order - right.block.order)
    result.push(...additions.map(({ block }) => block))
    const block = content[boundary]
    if (block) result.push(block)
  }
  return result
}

function remapTranslatedContent(
  translatedBlocks: TranslatedMarkdownBlock[],
  originalContent: AlignedMarkdownBlock[]
): AlignedMarkdownBlock[] {
  const sourceIndexes = translatedBlocks.map((block) => block.sourceIndex)
  const validSourceIndexes =
    translatedBlocks.length === originalContent.length &&
    sourceIndexes.every((sourceIndex): sourceIndex is number => Number.isInteger(sourceIndex) && sourceIndex! >= 0) &&
    new Set(sourceIndexes).size === sourceIndexes.length &&
    [...sourceIndexes].sort((left, right) => left - right)
      .every((sourceIndex, index) => sourceIndex === index)

  if (!validSourceIndexes) {
    return translatedBlocks.map((block) => ({ markdown: block.markdown, mappingIds: [], ...withFallback(block) }))
  }
  return [...translatedBlocks]
    .sort((left, right) => left.sourceIndex! - right.sourceIndex!)
    .map((block) => ({
      markdown: block.markdown,
      mappingIds: [...(originalContent[block.sourceIndex!]?.mappingIds ?? [])],
      ...withFallback(block)
    }))
}

function withFallback(block: TranslatedMarkdownBlock): Pick<AlignedMarkdownBlock, 'fallbackProvider' | 'sourceChanged'> {
  return { ...(block.fallbackProvider ? { fallbackProvider: block.fallbackProvider } : {}), ...(block.sourceChanged ? { sourceChanged: true as const } : {}) }
}

function reuseOriginalMapping(markdown: string): AlignedMarkdownBlock[] {
  const translated = splitMarkdownBlocks(markdown)
  return translated.map((block) => ({
    markdown: block,
    mappingIds: []
  }))
}

function supplementalRole(mapping: BlockMapping): Exclude<ReaderBlockRole, 'content' | 'page-divider'> | null {
  if (mapping.boxes.length === 0 || !mapping.boxes.every((box) => box.isDiscarded)) return null
  const type = normalizeType(mapping.type)
  if (HEADER_TYPES.has(type)) return 'page-header'
  if (FOOTER_TYPES.has(type)) return 'page-footer'
  if (PAGE_NUMBER_TYPES.has(type)) return 'page-number'
  if (FOOTNOTE_TYPES.has(type) || type.endsWith('_footnote')) return 'footnote'
  return null
}

function normalizeType(value: string): string {
  return value.trim().toLocaleLowerCase('en-US').replace(/[\s-]+/g, '_')
}

function firstPageIndex(mapping: BlockMapping): number | undefined {
  const pages = mapping.boxes.map((box) => box.pageIndex)
  return pages.length > 0 ? Math.min(...pages) : undefined
}

function contentBlockPages(
  block: AlignedMarkdownBlock,
  mappingById: Map<string, BlockMapping>
): number[] {
  return [...new Set(block.mappingIds.flatMap((id) =>
    mappingById.get(id)?.boxes
      .filter((box) => !box.isDiscarded)
      .map((box) => box.pageIndex) ?? []
  ))].sort((left, right) => left - right)
}

function addBoundaryBlocks(
  boundaries: Map<number, BoundaryBlock[]>,
  boundary: number,
  pageIndex: number,
  blocks: ReaderBlock[]
): void {
  if (blocks.length === 0) return
  const current = boundaries.get(boundary) ?? []
  current.push(...blocks.map((block) => ({ block, pageIndex })))
  boundaries.set(boundary, current)
}

function boundaryForUnmappedPage(
  pageIndex: number,
  pagesByContentIndex: number[][],
  contentLength: number
): number {
  for (const [contentIndex, pages] of pagesByContentIndex.entries()) {
    const firstPage = pages[0]
    if (firstPage !== undefined && firstPage > pageIndex) return contentIndex
  }
  return contentLength
}
