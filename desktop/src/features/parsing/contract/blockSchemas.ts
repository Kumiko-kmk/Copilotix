import { z } from 'zod'
export { blockBoxSchema, blockMappingSchema } from '@features/document/contract/blockSchemas'
export const repairTextLayerResultSchema = z.object({
  repaired: z.number().int().min(0).max(1_000_000),
  unresolved: z.number().int().min(0).max(1_000_000)
}).strict()

export type RepairTextLayerResult = z.infer<typeof repairTextLayerResultSchema>
