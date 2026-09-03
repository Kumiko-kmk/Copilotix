import { createHash } from 'node:crypto'
import type { BlockMapping } from '@shared/types'

export const BLOCK_MAPPING_VERSION = 2

/** Bounded utility-side mapping projection for MinerU layout JSON. */
export function buildUtilityBlockMappings(taskId: string, layout: unknown): BlockMapping[] {
  const pages = asObject(layout)?.pdf_info
  if (!Array.isArray(pages)) return []
  const mappings: BlockMapping[] = []
  for (const [pageOrder, pageValue] of pages.entries()) {
    const page = asObject(pageValue)
    const pageIndex = typeof page?.page_idx === 'number' ? page.page_idx : pageOrder
    const pageSize = toPageSize(page?.page_size)
    const blocks = Array.isArray(page?.para_blocks) ? page.para_blocks : []
    for (const [blockOrder, blockValue] of blocks.entries()) {
      const block = asObject(blockValue)
      const bbox = toBbox(block?.bbox)
      if (!bbox) continue
      const position = typeof block?.block_position === 'string' ? block.block_position : `${pageIndex}-${blockOrder}`
      const sourceText = typeof block?.text === 'string' ? block.text.trim() : ''
      mappings.push({
        id: `block-${createHash('sha256').update(`${taskId}:${position}`).digest('hex').slice(0, 20)}`,
        order: mappings.length,
        type: typeof block?.type === 'string' ? block.type : 'text',
        sourceText,
        sourceAsset: typeof block?.image_path === 'string' ? block.image_path : undefined,
        boxes: [{ pageIndex, bbox, pageSize, blockPosition: position }]
      })
    }
  }
  return mappings
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}
function toBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4 || value.some((part) => typeof part !== 'number' || !Number.isFinite(part))) return null
  return [value[0] as number, value[1] as number, value[2] as number, value[3] as number]
}
function toPageSize(value: unknown): [number, number] {
  if (Array.isArray(value) && value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') return [value[0], value[1]]
  const object = asObject(value)
  if (typeof object?.width === 'number' && typeof object?.height === 'number') return [object.width, object.height]
  return [612, 792]
}
