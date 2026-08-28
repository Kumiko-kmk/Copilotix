import { createHash } from 'node:crypto'
import type { BlockBox, BlockMapping } from '@shared/types'

interface LayoutBlock {
  bbox?: unknown
  type?: unknown
  index?: unknown
  id?: unknown
  block_position?: unknown
  lines?: unknown
  blocks?: unknown
  text?: unknown
  lines_deleted?: unknown
  merge_prev?: unknown
  is_discarded?: unknown
}

interface LayoutPage {
  page_idx?: unknown
  page_size?: unknown
  discarded_blocks?: LayoutBlock[]
  para_blocks?: LayoutBlock[]
}

interface SourceBlock {
  pageIndex: number
  pageSize: [number, number]
  position: string
  type: string
  bbox: [number, number, number, number]
  sourceText: string
  sourceAsset?: string
  lines: Array<[number, number, number, number]>
  isDiscarded: boolean
  isDeleted: boolean
  mergePrevious: boolean
  order: number
}

interface MappingGroup {
  type: string
  sourceText: string
  sourceAsset?: string
  boxes: BlockBox[]
  firstOrder: number
}

export const BLOCK_MAPPING_VERSION = 2

export function buildBlockMappings(taskId: string, layout: unknown): BlockMapping[] {
  const existing = parseExistingBlockList(taskId, layout)
  if (existing.length > 0) return existing

  const pages = asObject(layout)?.pdf_info
  if (!Array.isArray(pages)) return []
  const sourceBlocks: SourceBlock[] = []

  pages.forEach((pageValue, pageOrder) => {
    const page = pageValue as LayoutPage
    const pageIndex = typeof page.page_idx === 'number' ? page.page_idx : pageOrder
    const pageSize = toPageSize(page.page_size)
    const contentBlocks = (Array.isArray(page.para_blocks) ? page.para_blocks : []).flatMap(expandLayoutBlock)
    const discardedBlocks = (Array.isArray(page.discarded_blocks) ? page.discarded_blocks : []).flatMap(expandLayoutBlock)
    const blocks = [
      ...contentBlocks.map((block) => ({ block, isDiscarded: false })),
      ...discardedBlocks.map((block) => ({ block, isDiscarded: true }))
    ].sort((left, right) => layoutSortIndex(left.block, left.isDiscarded) - layoutSortIndex(right.block, right.isDiscarded))
    blocks.forEach(({ block, isDiscarded }, blockOrder) => {
      const bbox = toBbox(block.bbox)
      if (!bbox) return
      sourceBlocks.push({
        pageIndex,
        pageSize,
        position: `${pageIndex}-${blockOrder}`,
        type: typeof block.type === 'string' ? block.type : 'text',
        bbox,
        sourceText: extractBlockText(block),
        sourceAsset: extractBlockAsset(block),
        lines: extractLineBoxes(block),
        isDiscarded: isDiscarded || block.is_discarded === true,
        isDeleted: block.lines_deleted === true,
        mergePrevious: block.merge_prev === true,
        order: sourceBlocks.length
      })
    })
  })

  const groups: MappingGroup[] = []
  const groupByBlock = new Map<SourceBlock, MappingGroup>()
  for (const block of sourceBlocks) {
    const owner = block.isDeleted
      ? findDeletedBlockOwner(sourceBlocks, groupByBlock, block)
      : block.mergePrevious
        ? findPreviousGroup(sourceBlocks, groupByBlock, block)
        : null
    const group = owner ?? {
      type: block.type,
      sourceText: '',
      sourceAsset: block.sourceAsset,
      boxes: [],
      firstOrder: block.order
    }
    if (!owner) groups.push(group)
    if (block.sourceText) group.sourceText = joinBlockText(group.sourceText, block.sourceText)
    if (!group.sourceAsset && block.sourceAsset) group.sourceAsset = block.sourceAsset
    group.boxes.push({
      pageIndex: block.pageIndex,
      bbox: block.bbox,
      pageSize: block.pageSize,
      blockPosition: block.position,
      isDiscarded: block.isDiscarded
    })
    groupByBlock.set(block, group)
  }

  return groups
    .sort((left, right) => left.firstOrder - right.firstOrder)
    .map((group, order) => finalizeMapping(taskId, group, order))
}

export function stableBlockId(taskId: string, positions: string[]): string {
  return `block-${createHash('sha256').update(`${taskId}:${positions.join('|')}`).digest('hex').slice(0, 20)}`
}

function parseExistingBlockList(taskId: string, input: unknown): BlockMapping[] {
  const object = asObject(input)
  const pages = object?.pdfData
  if (!Array.isArray(pages)) return []
  const byLogicalId = new Map<string, { type: string; sourceText: string; sourceAsset?: string; boxes: BlockBox[] }>()

  pages.forEach((pageValue, pageOrder) => {
    const page = asObject(pageValue)
    const blocks = Array.isArray(page?.blocks) ? page.blocks : Array.isArray(pageValue) ? pageValue : []
    for (const blockValue of blocks) {
      const block = asObject(blockValue)
      const bbox = toBbox(block?.bbox)
      if (!bbox) continue
      const pageIndex = typeof block?.page_idx === 'number' ? block.page_idx : pageOrder
      const position = typeof block?.block_position === 'string' ? block.block_position : `${pageIndex}-${byLogicalId.size}`
      const sourceId = typeof block?.id === 'string' ? block.id : position
      const entry = byLogicalId.get(sourceId) ?? {
        type: typeof block?.type === 'string' ? block.type : 'text',
        sourceText: '',
        boxes: []
      }
      if (typeof block?.text === 'string' && block.text) entry.sourceText = joinBlockText(entry.sourceText, block.text)
      entry.boxes.push({
        pageIndex,
        bbox,
        pageSize: toPageSize(block?.page_size),
        blockPosition: position,
        isDiscarded: block?.is_discarded === true
      })
      byLogicalId.set(sourceId, entry)
    }
  })

  return [...byLogicalId.values()].map((entry, order) => finalizeMapping(taskId, { ...entry, firstOrder: order }, order))
}

function finalizeMapping(taskId: string, group: MappingGroup, order: number): BlockMapping {
  const merged = group.boxes.length > 1
  return {
    id: stableBlockId(taskId, group.boxes.map((box) => box.blockPosition)),
    order,
    type: group.type,
    sourceText: group.sourceText.trim(),
    sourceAsset: group.sourceAsset,
    boxes: group.boxes.map((box, index) => ({
      ...box,
      mergeRole: merged ? (index === 0 ? 'source' : 'continuation') : undefined
    }))
  }
}

function expandLayoutBlock(block: LayoutBlock): LayoutBlock[] {
  const type = typeof block.type === 'string' ? block.type : ''
  if (!['image', 'chart', 'table'].includes(type) || !Array.isArray(block.blocks) || block.blocks.length === 0) return [block]
  return block.blocks
    .map((child) => asObject(child))
    .filter((child): child is Record<string, any> => Boolean(child))
    .map((child) => ({
      ...child,
      index: typeof child.index === 'number' ? child.index : block.index,
      type: normalizeCompoundType(typeof child.type === 'string' ? child.type : type)
    }))
}

function normalizeCompoundType(type: string): string {
  if (type === 'image_body') return 'image'
  if (type === 'chart_body') return 'chart'
  if (type === 'table_body') return 'table'
  return type
}

function layoutSortIndex(block: LayoutBlock, isDiscarded: boolean): number {
  const index = typeof block.index === 'number' ? block.index : Number.MAX_SAFE_INTEGER / 2
  if (!isDiscarded) return index
  const type = typeof block.type === 'string' ? block.type : ''
  return ['header', 'page_header'].includes(type) ? index - 100_000 : index + 1_000_000
}

function findDeletedBlockOwner(
  blocks: SourceBlock[],
  groups: Map<SourceBlock, MappingGroup>,
  target: SourceBlock
): MappingGroup | null {
  for (let index = target.order - 1; index >= 0; index -= 1) {
    const candidate = blocks[index]
    if (!candidate || candidate.isDeleted || candidate.type !== target.type || candidate.isDiscarded !== target.isDiscarded) continue
    const group = groups.get(candidate)
    if (!group) continue
    const overflow = candidate.lines.filter((line) => !containsCenter(candidate.bbox, line) && overlaps(target.bbox, line))
    if (overflow.length > 0) return group
  }
  return null
}

function findPreviousGroup(
  blocks: SourceBlock[],
  groups: Map<SourceBlock, MappingGroup>,
  target: SourceBlock
): MappingGroup | null {
  for (let index = target.order - 1; index >= 0; index -= 1) {
    const candidate = blocks[index]
    if (!candidate || candidate.isDeleted || candidate.isDiscarded !== target.isDiscarded) continue
    const group = groups.get(candidate)
    if (group && (candidate.type === target.type || target.mergePrevious)) return group
  }
  return null
}

function extractBlockText(block: LayoutBlock): string {
  if (typeof block.text === 'string') return block.text.trim()
  const lines = extractLines(block)
  let result = ''
  for (const line of lines) {
    const spans = Array.isArray(line?.spans) ? line.spans : []
    const text = spans
      .map((span: unknown) => {
        const object = asObject(span)
        if (typeof object?.content === 'string') return object.content
        if (typeof object?.html === 'string') return object.html
        return ''
      })
      .join('')
      .trim()
    if (!text) continue
    if (/[-\u00ad\u2010\u2011]\s*$/u.test(result) && /^\p{Ll}/u.test(text)) {
      result = `${result.replace(/[-\u00ad\u2010\u2011]\s*$/u, '')}${text}`
    } else {
      result = joinBlockText(result, text)
    }
  }
  return result.trim()
}

function extractLineBoxes(block: LayoutBlock): Array<[number, number, number, number]> {
  return extractLines(block).map((line) => toBbox(line?.bbox)).filter((bbox): bbox is [number, number, number, number] => Boolean(bbox))
}

function extractBlockAsset(block: LayoutBlock): string | undefined {
  for (const line of extractLines(block)) {
    const spans = Array.isArray(line?.spans) ? line.spans : []
    for (const span of spans) {
      const object = asObject(span)
      if (typeof object?.image_path === 'string' && object.image_path) return object.image_path
    }
  }
  return undefined
}

function extractLines(block: LayoutBlock): Array<Record<string, any>> {
  if (Array.isArray(block.lines) && block.lines.length > 0) {
    return block.lines.map(asObject).filter((line): line is Record<string, any> => Boolean(line))
  }
  if (!Array.isArray(block.blocks)) return []
  return block.blocks.flatMap((child) => {
    const object = asObject(child)
    return object ? extractLines(object as LayoutBlock) : []
  })
}

function joinBlockText(left: string, right: string): string {
  if (!left) return right
  if (!right) return left
  return `${left.trimEnd()} ${right.trimStart()}`
}

function containsCenter(container: [number, number, number, number], box: [number, number, number, number]): boolean {
  const centerX = (box[0] + box[2]) / 2
  const centerY = (box[1] + box[3]) / 2
  return centerX >= container[0] && centerX <= container[2] && centerY >= container[1] && centerY <= container[3]
}

function overlaps(left: [number, number, number, number], right: [number, number, number, number]): boolean {
  const intersectionWidth = Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0]))
  const intersectionHeight = Math.max(0, Math.min(left[3], right[3]) - Math.max(left[1], right[1]))
  return intersectionWidth > 0 && intersectionHeight > 0
}

function asObject(value: unknown): Record<string, any> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, any>) : null
}

function toBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4 || value.some((part) => typeof part !== 'number')) return null
  return [value[0], value[1], value[2], value[3]]
}

function toPageSize(value: unknown): [number, number] {
  if (Array.isArray(value) && value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    return [value[0], value[1]]
  }
  const object = asObject(value)
  if (typeof object?.width === 'number' && typeof object?.height === 'number') return [object.width, object.height]
  return [612, 792]
}
