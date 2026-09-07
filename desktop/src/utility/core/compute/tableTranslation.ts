import { parseFragment, serialize } from 'parse5'
import { unified } from 'unified'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import type { BlockMapping } from '@shared/types'
import type { AlignedMarkdownBlock } from '@shared/markdownBlocks'
import { splitMarkdownMath } from '@shared/mathDelimiters'
import {
  TABLE_TRANSLATION_PROTOCOL,
  validateTableTranslationResponse,
  type TableTextSegment,
  type TableCellPayload,
  type TableAttachmentPayload,
  type TablePayload,
  type TableTranslationRequest,
  type TableTranslationResponse
} from '@shared/translationPlanProtocol'

export {
  TABLE_TRANSLATION_PROTOCOL,
  TABLE_TRANSLATION_CACHE_VERSION,
  validateTableTranslationResponse,
  type TableTextSegment,
  type TableCellPayload,
  type TableAttachmentPayload,
  type TablePayload,
  type TableTranslationRequest,
  type TableTranslationResponse
} from '@shared/translationPlanProtocol'

export interface TableTranslationSourceBlock {
  sourceIndex: number
  markdown: string
  mappingIds: string[]
}

interface SegmentBinding {
  id: string
  source: string
  apply(value: string): void
}

export interface RenderableBlockPlan extends TableTranslationSourceBlock {
  render(): string
}

export interface TableTranslationPlan {
  request: TableTranslationRequest
  blocks: RenderableBlockPlan[]
  bindings: SegmentBinding[]
  hasTranslatableText: boolean
}

export interface TableTranslationUnit {
  blocks: TableTranslationSourceBlock[]
  plan: TableTranslationPlan
}

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkStringify, { bullet: '-', fences: true, listItemIndent: 'one' })

const PROTECTED_HTML_TAGS = new Set(['code', 'pre', 'math', 'inline-math', 'eq', 'script', 'style'])

/**
 * Groups a table HTML block with its directly adjacent MinerU caption and footnote blocks.
 * Generic neighboring paragraphs are intentionally not included.
 */
export function buildTableTranslationUnits(
  sourceBlocks: AlignedMarkdownBlock[],
  mappings: BlockMapping[]
): TableTranslationUnit[] {
  const mappingById = new Map(mappings.map((mapping) => [mapping.id, mapping]))
  const consumed = new Set<number>()
  const units: TableTranslationUnit[] = []
  let tableOrdinal = 0

  for (let sourceIndex = 0; sourceIndex < sourceBlocks.length; sourceIndex += 1) {
    if (consumed.has(sourceIndex) || !containsTableMarkup(sourceBlocks[sourceIndex]?.markdown ?? '')) continue

    const captionIndexes: number[] = []
    for (let index = sourceIndex - 1; index >= 0 && isMappingType(sourceBlocks[index], mappingById, 'table_caption'); index -= 1) {
      captionIndexes.unshift(index)
    }

    const footnoteIndexes: number[] = []
    for (
      let index = sourceIndex + 1;
      index < sourceBlocks.length && isMappingType(sourceBlocks[index], mappingById, 'table_footnote');
      index += 1
    ) {
      footnoteIndexes.push(index)
    }

    const indexes = [...captionIndexes, sourceIndex, ...footnoteIndexes]
    const blocks = indexes.map((index) => ({
      sourceIndex: index,
      markdown: sourceBlocks[index]!.markdown,
      mappingIds: [...sourceBlocks[index]!.mappingIds]
    }))
    const plan = buildTableTranslationPlan(blocks, tableOrdinal)
    if (!plan) continue

    tableOrdinal += 1
    for (const index of indexes) consumed.add(index)
    units.push({ blocks, plan })
  }

  return units
}

export function buildTableTranslationPlan(
  blocks: TableTranslationSourceBlock[],
  tableOrdinal = 0
): TableTranslationPlan | null {
  const tableBlock = blocks.find((block) => containsTableMarkup(block.markdown))
  if (!tableBlock) return null

  const fragment = parseFragment(tableBlock.markdown) as any
  const bindings: SegmentBinding[] = []
  const tables = findElements(fragment, 'table')
  if (tables.length === 0) return null

  const tablePayloads = tables.map((table, tableIndex) =>
    buildTablePayload(table, `table-${tableOrdinal}-${tableIndex}`, bindings)
  )
  const captionPlans = blocks
    .filter((block) => block.sourceIndex < tableBlock.sourceIndex)
    .map((block, attachmentIndex) => buildAttachment(block, `table-${tableOrdinal}-caption-${attachmentIndex}`, bindings))
  const footnotePlans = blocks
    .filter((block) => block.sourceIndex > tableBlock.sourceIndex)
    .map((block, attachmentIndex) => buildAttachment(block, `table-${tableOrdinal}-footnote-${attachmentIndex}`, bindings))

  const renderableBlocks: RenderableBlockPlan[] = blocks.map((block) => {
    if (block.sourceIndex === tableBlock.sourceIndex) {
      return {
        ...block,
        render: () => serialize(fragment).trimEnd()
      }
    }
    const attachment = [...captionPlans, ...footnotePlans].find((candidate) => candidate.sourceIndex === block.sourceIndex)
    if (!attachment) throw new Error(`表格附件 ${block.sourceIndex} 未生成翻译计划`)
    return {
      ...block,
      render: attachment.render
    }
  })

  return {
    request: {
      protocol: TABLE_TRANSLATION_PROTOCOL,
      targetLanguage: 'zh-CN',
      tables: tablePayloads.map((table, index) => ({
        ...table,
        captions: index === 0 ? captionPlans.map(({ payload }) => payload) : [],
        footnotes: index === 0 ? footnotePlans.map(({ payload }) => payload) : []
      }))
    },
    blocks: renderableBlocks,
    bindings,
    hasTranslatableText: bindings.length > 0
  }
}

export function applyTableTranslation(
  plan: TableTranslationPlan,
  response: TableTranslationResponse
): void {
  const validated = validateTableTranslationResponse(response, plan.request)
  const translations = new Map(validated.translations.map((segment) => [segment.id, segment.text]))
  for (const binding of plan.bindings) {
    const translated = translations.get(binding.id)
    binding.apply(normalizeTableText(binding.source, translated!))
  }
}

export function parseTableTranslationResponse(
  raw: string,
  request: TableTranslationRequest
): TableTranslationResponse {
  const text = stripJsonCodeFence(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('表格翻译源返回的内容不是有效 JSON')
  }
  return validateTableTranslationResponse(parsed, request)
}

function buildTablePayload(table: any, tableId: string, bindings: SegmentBinding[]): TablePayload {
  const rowNodes = findDirectTableRows(table)
  const occupied = new Map<number, Set<number>>()
  const rows: TableCellPayload[][] = []

  for (let rowIndex = 0; rowIndex < rowNodes.length; rowIndex += 1) {
    const rowNode = rowNodes[rowIndex]
    const cells = findDirectRowCells(rowNode)
    const rowPayload: TableCellPayload[] = []
    let column = 0
    for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
      while (occupied.get(rowIndex)?.has(column)) column += 1
      const cellNode = cells[cellIndex]
      const rowspan = positiveAttribute(cellNode, 'rowspan')
      const colspan = positiveAttribute(cellNode, 'colspan')
      const cellId = `${tableId}-cell-r${rowIndex}-c${column}`
      const segments = collectHtmlSegments(cellNode, cellId, bindings)
      const payload: TableCellPayload = {
        id: cellId,
        tag: cellNode.nodeName === 'th' ? 'th' : 'td',
        row: rowIndex,
        column,
        rowspan,
        colspan,
        segments
      }
      rowPayload.push(payload)
      for (let row = rowIndex; row < rowIndex + rowspan; row += 1) {
        const columns = occupied.get(row) ?? new Set<number>()
        for (let offset = 0; offset < colspan; offset += 1) columns.add(column + offset)
        occupied.set(row, columns)
      }
      column += colspan
    }
    rows.push(rowPayload)
  }

  return { id: tableId, rows, captions: [], footnotes: [] }
}

function buildAttachment(
  block: TableTranslationSourceBlock,
  attachmentId: string,
  bindings: SegmentBinding[]
): { payload: TableAttachmentPayload; sourceIndex: number; render: () => string } {
  const tree = markdownProcessor.parse(block.markdown) as any
  const segments = collectMarkdownSegments(tree, attachmentId, bindings)
  return {
    payload: { id: attachmentId, sourceIndex: block.sourceIndex, segments },
    sourceIndex: block.sourceIndex,
    render: () => String(markdownProcessor.stringify(tree)).trimEnd()
  }
}

function collectHtmlSegments(node: any, prefix: string, bindings: SegmentBinding[]): TableTextSegment[] {
  const segments: TableTextSegment[] = []
  const walk = (current: any, protectedAncestor: boolean): void => {
    if (!current || current.nodeName === 'table') return
    const tag = typeof current.nodeName === 'string' ? current.nodeName.toLowerCase() : ''
    const protectedHere = protectedAncestor || PROTECTED_HTML_TAGS.has(tag)
    if (current.nodeName === '#text' && !protectedHere && typeof current.value === 'string') {
      segments.push(...bindTextNode(current, prefix, segments.length, bindings))
      return
    }
    if (!Array.isArray(current.childNodes)) return
    for (const child of current.childNodes) walk(child, protectedHere)
  }
  for (const child of node.childNodes ?? []) walk(child, false)
  return segments
}

function collectMarkdownSegments(node: any, prefix: string, bindings: SegmentBinding[]): TableTextSegment[] {
  const segments: TableTextSegment[] = []
  const walk = (current: any, protectedAncestor: boolean): void => {
    const protectedHere = protectedAncestor || ['code', 'inlineCode', 'math', 'inlineMath', 'html'].includes(current?.type)
    if (current?.type === 'text' && !protectedHere && typeof current.value === 'string') {
      segments.push(...bindTextNode(current, prefix, segments.length, bindings))
      return
    }
    if (!Array.isArray(current?.children)) return
    for (const child of current.children) walk(child, protectedHere)
  }
  for (const child of node.children ?? []) walk(child, false)
  return segments
}

function bindTextNode(
  node: { value: string },
  prefix: string,
  segmentOffset: number,
  bindings: SegmentBinding[]
): TableTextSegment[] {
  const parts = splitMarkdownMath(node.value)
  const state = parts.map((part) => ({
    source: part.value,
    translated: undefined as string | undefined,
    id: undefined as string | undefined
  }))
  const segments: TableTextSegment[] = []
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const part = parts[partIndex]!
    if (part.kind !== 'text' || !isTranslatableTableText(part.value)) continue
    const id = `${prefix}-segment-${segmentOffset + segments.length}`
    state[partIndex]!.id = id
    const statePart = state[partIndex]!
    bindings.push({
      id,
      source: part.value,
      apply: (value) => {
        statePart.translated = value
        node.value = state.map((item) => item.translated ?? item.source).join('')
      }
    })
    segments.push({ id, text: part.value })
  }
  return segments
}

function findElements(root: any, name: string): any[] {
  const elements: any[] = []
  const walk = (node: any): void => {
    if (!node) return
    if (node.nodeName === name) elements.push(node)
    for (const child of node.childNodes ?? []) walk(child)
  }
  walk(root)
  return elements
}

function findDirectTableRows(table: any): any[] {
  const rows: any[] = []
  walkWithoutNestedTable(table, (node) => {
    if (node !== table && node.nodeName === 'tr') rows.push(node)
  })
  return rows
}

function findDirectRowCells(row: any): any[] {
  const cells: any[] = []
  walkWithoutNestedTable(row, (node) => {
    if (node !== row && (node.nodeName === 'td' || node.nodeName === 'th')) cells.push(node)
  })
  return cells
}

function walkWithoutNestedTable(root: any, visit: (node: any) => void): void {
  const walk = (node: any): void => {
    visit(node)
    if (node !== root && node.nodeName === 'table') return
    for (const child of node.childNodes ?? []) walk(child)
  }
  walk(root)
}

function positiveAttribute(node: any, name: string): number {
  const raw = node.attrs?.find((attribute: { name: string }) => attribute.name.toLowerCase() === name)?.value
  const value = Number.parseInt(raw ?? '', 10)
  return Number.isInteger(value) && value > 0 ? value : 1
}

function isMappingType(
  block: AlignedMarkdownBlock | undefined,
  mappingById: Map<string, BlockMapping>,
  type: string
): boolean {
  return Boolean(block?.mappingIds.some((id) => mappingById.get(id)?.type === type))
}

function containsTableMarkup(markdown: string): boolean {
  return /<table(?:\s|>)/i.test(markdown)
}

function isTranslatableTableText(value: string): boolean {
  if (!/[A-Za-z\p{L}]/u.test(value)) return false
  const letters = value.match(/[A-Za-z]/g)?.length ?? 0
  const han = value.match(/[\p{Script=Han}]/gu)?.length ?? 0
  return letters > 0 || han === 0
}

function normalizeTableText(source: string, translated: string): string {
  const leadingWhitespace = source.match(/^[\p{Zs}\t]+/u)?.[0] ?? ''
  const trailingWhitespace = source.match(/[\p{Zs}\t]+$/u)?.[0] ?? ''
  const value = translated.trim()
  if (!value) throw new Error('表格翻译源返回了空译文')
  const normalized = value.replace(/\r\n?/g, '\n')
  const content = !/[\r\n]/.test(source)
    ? normalized.replace(/[ \t]*\n+[ \t]*/g, ' ')
    : normalized.replace(/\n{2,}/g, '\n')
  return `${leadingWhitespace}${content}${trailingWhitespace}`
}

function stripJsonCodeFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}
