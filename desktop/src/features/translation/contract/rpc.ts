import { z } from 'zod'
import { noNul } from '@platform/rpc/contract/protocol'
import { translationProviderIdSchema } from '@shared/ipcSchemas'
import {
  translationPlanFinalizeResultSchema,
  translationPlanListResultSchema,
  translationPlanMutationResultSchema,
  translationPlanOpenResultSchema
} from './translationPlanProtocol'

const coreTranslationPlanIdSchema = z.string().uuid().refine(noNul, 'translation plan id cannot contain NUL')
const coreTranslationPlanPathSchema = z.string().min(1).max(1_024).refine(noNul, 'translation plan path cannot contain NUL').refine((value) =>
  value.startsWith('.translation/') && !value.startsWith('/') && !value.includes('\\') &&
  !value.split('/').some((part) => part === '..' || part.length === 0),
  'translation plan path must be a normalized relative .translation path'
)
const coreTranslationPlanErrorSchema = z.string().max(32_768).refine(noNul, 'translation plan error cannot contain NUL')
export const coreTranslationPlanOpenPayloadSchema = z.object({
  taskId: coreTranslationPlanIdSchema,
  jobId: coreTranslationPlanIdSchema
}).strict()
export const coreTranslationPlanOpenResultSchema = translationPlanOpenResultSchema
export const coreTranslationPlanListPayloadSchema = z.object({
  taskId: coreTranslationPlanIdSchema,
  jobId: coreTranslationPlanIdSchema,
  cursor: z.number().int().min(0).max(100_000).optional(),
  limit: z.number().int().min(1).max(32).optional()
}).strict()
export const coreTranslationPlanListResultSchema = translationPlanListResultSchema
export const coreTranslationPlanCachePayloadSchema = z.object({
  taskId: coreTranslationPlanIdSchema,
  jobId: coreTranslationPlanIdSchema,
  unitId: coreTranslationPlanIdSchema,
  provider: translationProviderIdSchema,
  model: z.string().min(1).max(512).refine(noNul)
}).strict()
export const coreTranslationPlanCacheResultSchema = translationPlanMutationResultSchema
export const coreTranslationPlanApplyPayloadSchema = z.object({
  taskId: coreTranslationPlanIdSchema,
  jobId: coreTranslationPlanIdSchema,
  unitId: coreTranslationPlanIdSchema,
  responsePath: coreTranslationPlanPathSchema.optional(),
  provider: translationProviderIdSchema.nullable().optional(),
  model: z.string().max(512).refine(noNul).nullable().optional()
}).strict()
export const coreTranslationPlanApplyResultSchema = translationPlanMutationResultSchema
export const coreTranslationPlanFailPayloadSchema = z.object({
  taskId: coreTranslationPlanIdSchema,
  jobId: coreTranslationPlanIdSchema,
  unitId: coreTranslationPlanIdSchema,
  error: coreTranslationPlanErrorSchema.optional()
}).strict()
export const coreTranslationPlanFailResultSchema = translationPlanMutationResultSchema
export const coreTranslationPlanFinalizePayloadSchema = z.object({
  taskId: coreTranslationPlanIdSchema,
  jobId: coreTranslationPlanIdSchema
}).strict()
export const coreTranslationPlanFinalizeResultSchema = translationPlanFinalizeResultSchema

/** Core RPC operations of the durable translation plan in Utility (compute lane). */
export const translationOperations = {
  'compute:translation-plan-open': { payload: coreTranslationPlanOpenPayloadSchema, result: coreTranslationPlanOpenResultSchema },
  'compute:translation-plan-list': { payload: coreTranslationPlanListPayloadSchema, result: coreTranslationPlanListResultSchema },
  'compute:translation-plan-cache': { payload: coreTranslationPlanCachePayloadSchema, result: coreTranslationPlanCacheResultSchema },
  'compute:translation-plan-apply': { payload: coreTranslationPlanApplyPayloadSchema, result: coreTranslationPlanApplyResultSchema },
  'compute:translation-plan-fail': { payload: coreTranslationPlanFailPayloadSchema, result: coreTranslationPlanFailResultSchema },
  'compute:translation-plan-finalize': { payload: coreTranslationPlanFinalizePayloadSchema, result: coreTranslationPlanFinalizeResultSchema }
} as const
export type TranslationOperations = typeof translationOperations
