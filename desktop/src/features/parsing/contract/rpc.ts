import { z } from 'zod'
import { copilotixTaskSchema } from '@features/library/contract/documentSchemas'
import { coreIdSchema, corePathSchema, noNul } from '@platform/rpc/contract/protocol'

export const coreNormalizeParserPayloadSchema = z.object({ task: copilotixTaskSchema, extractedDir: corePathSchema, jobId: coreIdSchema.optional() }).strict()

export const coreNormalizeParserResultSchema = z.object({
  normalized: z.literal(true),
  displayTitle: z.string().max(32_768).refine(noNul).nullable(),
  pageCount: z.number().int().min(0).max(100_000)
}).strict()

export const coreRebuildMappingsPayloadSchema = z.object({ taskId: coreIdSchema, outputDir: corePathSchema }).strict()

export const coreRebuildMappingsResultSchema = z.object({ rebuilt: z.literal(true) }).strict()

export const coreRepairTextLayerPayloadSchema = z.object({ taskId: coreIdSchema }).strict()

export const coreRepairTextLayerResultSchema = z.object({
  repaired: z.number().int().min(0).max(1_000_000),
  unresolved: z.number().int().min(0).max(1_000_000)
}).strict()

/** Core RPC operations that publish parser output and rebuild or repair its block mappings in Utility. */
export const parsingOperations = {
  'compute:normalize-parser': { payload: coreNormalizeParserPayloadSchema, result: coreNormalizeParserResultSchema },
  'compute:rebuild-mappings': { payload: coreRebuildMappingsPayloadSchema, result: coreRebuildMappingsResultSchema },
  'compute:repair-text-layer': { payload: coreRepairTextLayerPayloadSchema, result: coreRepairTextLayerResultSchema }
} as const
export type ParsingOperations = typeof parsingOperations
