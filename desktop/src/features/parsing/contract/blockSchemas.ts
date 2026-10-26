import { z } from 'zod'
import { boundedId, boundedPath } from '@platform/ipc/contract/validation'
import type { BlockBox, BlockMapping } from './blocks'

/** IPC schemas for parsed block geometry, mappings and text-layer repair. */

export const blockBoxSchema: z.ZodType<BlockBox> = z.object({
  pageIndex: z.number().int().min(0),
  bbox: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
  pageSize: z.tuple([z.number().positive().finite(), z.number().positive().finite()]),
  blockPosition: z.string().min(1).max(4_096),
  isDiscarded: z.boolean().optional(),
  mergeRole: z.enum(['source', 'continuation']).optional()
}).strict()

export const blockMappingSchema: z.ZodType<BlockMapping> = z.object({
  id: boundedId,
  order: z.number().int().min(0),
  type: z.string().min(1).max(512),
  sourceText: z.string().max(16_777_216),
  sourceAsset: boundedPath.optional(),
  boxes: z.array(blockBoxSchema).max(100_000)
}).strict()

/** Lines replaced from the PDF text layer, and fragmented lines it could not confirm. */
export const repairTextLayerResultSchema = z.object({
  repaired: z.number().int().min(0).max(1_000_000),
  unresolved: z.number().int().min(0).max(1_000_000)
}).strict()

export type RepairTextLayerResult = z.infer<typeof repairTextLayerResultSchema>
