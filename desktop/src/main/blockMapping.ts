import { createHash } from 'node:crypto'
import type { BlockBox, BlockMapping } from '@shared/types'

interface LayoutBlock {
  bbox?: unknown
  type?: unknown
  index?: unknown
  id?: unknown
  block_position?: unknown
}

interface LayoutPage {
  page_idx?: unknown
  page_size?: unknown
  para_blocks?: LayoutBlock[]
}

export function buildBlockMappings(taskId: string, layout: unknown): BlockMapping[] {
  const existing = parseExistingBlockList(taskId, layout)
  if (existing.length > 0) return existing

  const pages = asObject(layout)?.pdf_info
  if (!Array.isArray(pages)) return []
  const mappings: BlockMapping[] = []

  pages.forEach((pageValue, pageOrder) => {
    const page = pageValue as LayoutPage
    const pageIndex = typeof page.page_idx === 'number' ? page.page_idx : pageOrder
    const pageSize = toPageSize(page.page_size)
    const blocks = Array.isArray(page.para_blocks) ? page.para_blocks : []
    blocks.forEach((block, blockOrder) => {
      const bbox = toBbox(block.bbox)
      if (!bbox) return
      const position = `${pageIndex}-${typeof block.index === 'number' ? block.index : blockOrder}`
      mappings.push({
        id: stableBlockId(taskId, [position]),
        order: mappings.length,
        type: typeof block.type === 'string' ? block.type : 'text',
        boxes: [{ pageIndex, bbox, pageSize, blockPosition: position }]
      })
    })
  })
  return mappings
}

export function stableBlockId(taskId: string, positions: string[]): string {
  return `block-${createHash('sha256').update(`${taskId}:${positions.join('|')}`).digest('hex').slice(0, 20)}`
}

function parseExistingBlockList(taskId: string, input: unknown): BlockMapping[] {
  const object = asObject(input)
  const pages = object?.pdfData
  if (!Array.isArray(pages)) return []
  const byLogicalId = new Map<string, { type: string; boxes: BlockBox[] }>()

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
        boxes: []
      }
      entry.boxes.push({ pageIndex, bbox, pageSize: toPageSize(block?.page_size), blockPosition: position })
      byLogicalId.set(sourceId, entry)
    }
  })

  return [...byLogicalId.values()].map((entry, order) => ({
    id: stableBlockId(taskId, entry.boxes.map((box) => box.blockPosition)),
    order,
    type: entry.type,
    boxes: entry.boxes
  }))
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
