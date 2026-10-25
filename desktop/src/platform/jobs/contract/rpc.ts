import { z } from 'zod'
import { coreIdSchema, coreTimestampSchema, noNul } from '@platform/rpc/contract/protocol'

type CoreJobJsonObject = Record<string, unknown>

function isBoundedJobJsonObject(value: unknown, depth = 0, seen = new WeakSet<object>()): value is CoreJobJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) return false
  const objectValue = value as object
  if (seen.has(objectValue) || Object.getPrototypeOf(objectValue) !== Object.prototype) return false
  seen.add(objectValue)
  try {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length > 64) return false
    return entries.every(([key, item]) => {
      if (key.length === 0 || key.length > 256 || !noNul(key)) return false
      if (typeof item === 'string') return item.length <= 4_096 && noNul(item)
      if (typeof item === 'number') return Number.isFinite(item)
      if (typeof item === 'boolean' || item === null) return true
      if (Array.isArray(item)) {
        return item.length <= 64 && item.every((entry) => isBoundedJobJsonValue(entry, depth + 1, seen))
      }
      return isBoundedJobJsonObject(item, depth + 1, seen)
    })
  } finally {
    seen.delete(objectValue)
  }
}

function isBoundedJobJsonValue(value: unknown, depth: number, seen: WeakSet<object>): boolean {
  if (typeof value === 'string') return value.length <= 4_096 && noNul(value)
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean' || value === null) return true
  if (Array.isArray(value)) return value.length <= 64 && value.every((entry) => isBoundedJobJsonValue(entry, depth + 1, seen))
  return isBoundedJobJsonObject(value, depth, seen)
}

/** Small, bounded metadata only; job payloads never carry documents or artifacts. */
export const coreJobJsonObjectSchema = z.custom<CoreJobJsonObject>(isBoundedJobJsonObject, 'Job metadata must be bounded JSON')

/** Job kinds are metadata only; raw document/vector/credential data is never a job RPC field. */
export const coreJobKindSchema = z.enum(['parse', 'translate', 'rag-content-index', 'rag-embed', 'rag-delete'])
export const coreJobStatusSchema = z.enum(['queued', 'running', 'retry-wait', 'succeeded', 'partial', 'failed', 'cancelled'])
export const coreJobSchema = z.object({
  id: coreIdSchema,
  documentId: coreIdSchema,
  dependsOnJobId: coreIdSchema.nullable(),
  kind: coreJobKindSchema,
  status: coreJobStatusSchema,
  progress: z.number().int().min(0).max(100),
  priority: z.number().int().min(-1_000_000).max(1_000_000),
  attempt: z.number().int().min(0).max(1_000_000),
  maxAttempts: z.number().int().min(1).max(100),
  payload: coreJobJsonObjectSchema,
  checkpoint: coreJobJsonObjectSchema,
  availableAt: coreTimestampSchema,
  leaseOwner: z.string().max(256).refine(noNul).nullable(),
  leaseExpiresAt: coreTimestampSchema.nullable(),
  errorCode: z.string().max(128).refine(noNul).nullable(),
  errorMessage: z.string().max(4_096).refine(noNul).nullable(),
  startedAt: coreTimestampSchema.nullable(),
  finishedAt: coreTimestampSchema.nullable(),
  createdAt: coreTimestampSchema,
  updatedAt: coreTimestampSchema
}).strict()
export const coreJobEventSchema = z.object({
  id: coreIdSchema,
  jobId: coreIdSchema,
  sequence: z.number().int().min(1),
  fromState: coreJobStatusSchema.nullable(),
  toState: coreJobStatusSchema,
  detail: coreJobJsonObjectSchema,
  createdAt: coreTimestampSchema
}).strict()
export const coreJobResultSchema = coreJobSchema.nullable()
export const coreJobsResultSchema = z.array(coreJobSchema).max(50_000)
export const coreJobEventsResultSchema = z.array(coreJobEventSchema).max(100_000)
export const coreJobEnqueuePayloadSchema = z.object({
  id: coreIdSchema.optional(),
  documentId: coreIdSchema,
  kind: coreJobKindSchema,
  dependsOnJobId: coreIdSchema.nullable().optional(),
  priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  maxAttempts: z.number().int().min(1).max(100).optional(),
  payload: coreJobJsonObjectSchema.optional(),
  checkpoint: coreJobJsonObjectSchema.optional(),
  availableAt: coreTimestampSchema.optional(),
  now: coreTimestampSchema.optional()
}).strict()
export const coreJobIdPayloadSchema = z.object({ id: coreIdSchema }).strict()
export const coreJobListPayloadSchema = z.object({
  documentId: coreIdSchema.optional(),
  kind: coreJobKindSchema.optional(),
  statuses: z.array(coreJobStatusSchema).max(7).optional(),
  limit: z.number().int().min(1).max(10_000).optional()
}).strict()
export const coreJobClaimPayloadSchema = z.object({
  now: coreTimestampSchema,
  leaseOwner: z.string().min(1).max(256).refine(noNul),
  leaseExpiresAt: coreTimestampSchema,
  limit: z.number().int().min(1).max(50).optional(),
  kind: coreJobKindSchema.optional()
}).strict()
export const coreJobHeartbeatPayloadSchema = z.object({
  jobId: coreIdSchema,
  leaseOwner: z.string().min(1).max(256).refine(noNul),
  leaseExpiresAt: coreTimestampSchema,
  now: coreTimestampSchema.optional()
}).strict()
export const coreJobProgressPayloadSchema = z.object({
  jobId: coreIdSchema,
  leaseOwner: z.string().min(1).max(256).refine(noNul),
  progress: z.number().int().min(0).max(100),
  checkpoint: coreJobJsonObjectSchema,
  now: coreTimestampSchema.optional()
}).strict()
export const coreJobCompletePayloadSchema = z.object({
  jobId: coreIdSchema,
  leaseOwner: z.string().min(1).max(256).refine(noNul),
  status: z.enum(['succeeded', 'partial']),
  progress: z.number().int().min(0).max(100).optional(),
  checkpoint: coreJobJsonObjectSchema.optional(),
  now: coreTimestampSchema.optional(),
  detail: coreJobJsonObjectSchema.optional()
}).strict()
export const coreJobFailOrRetryPayloadSchema = z.object({
  jobId: coreIdSchema,
  leaseOwner: z.string().min(1).max(256).refine(noNul),
  errorCode: z.string().min(1).max(128).refine(noNul),
  errorMessage: z.string().min(1).max(32_768).refine(noNul),
  availableAt: coreTimestampSchema.optional(),
  now: coreTimestampSchema.optional(),
  terminal: z.boolean().optional(),
  detail: coreJobJsonObjectSchema.optional()
}).strict()
export const coreJobCancelPayloadSchema = z.object({
  jobId: coreIdSchema,
  leaseOwner: z.string().min(1).max(256).refine(noNul),
  now: coreTimestampSchema.optional(),
  detail: coreJobJsonObjectSchema.optional()
}).strict()
export const coreJobManualRetryPayloadSchema = z.object({
  jobId: coreIdSchema,
  now: coreTimestampSchema.optional(),
  availableAt: coreTimestampSchema.optional(),
  detail: coreJobJsonObjectSchema.optional(),
  refreshTranslation: z.literal(true).optional()
}).strict()
export const coreJobRecoverExpiredPayloadSchema = z.object({ now: coreTimestampSchema }).strict()
export const coreJobEventsPayloadSchema = z.object({ jobId: coreIdSchema }).strict()

/** Durable job queue operations, served by the Utility-owned SQLite job repository. */
export const jobOperations = {
  'jobs:enqueue': { payload: coreJobEnqueuePayloadSchema, result: coreJobSchema },
  'jobs:get': { payload: coreJobIdPayloadSchema, result: coreJobResultSchema },
  'jobs:list': { payload: coreJobListPayloadSchema, result: coreJobsResultSchema },
  'jobs:claim-batch': { payload: coreJobClaimPayloadSchema, result: coreJobsResultSchema },
  'jobs:heartbeat': { payload: coreJobHeartbeatPayloadSchema, result: coreJobSchema },
  'jobs:update-progress': { payload: coreJobProgressPayloadSchema, result: coreJobSchema },
  'jobs:complete': { payload: coreJobCompletePayloadSchema, result: coreJobSchema },
  'jobs:fail-or-retry': { payload: coreJobFailOrRetryPayloadSchema, result: coreJobSchema },
  'jobs:cancel': { payload: coreJobCancelPayloadSchema, result: coreJobSchema },
  'jobs:manual-retry': { payload: coreJobManualRetryPayloadSchema, result: coreJobSchema },
  'jobs:recover-expired': { payload: coreJobRecoverExpiredPayloadSchema, result: coreJobsResultSchema },
  'jobs:list-events': { payload: coreJobEventsPayloadSchema, result: coreJobEventsResultSchema }
} as const
export type JobOperations = typeof jobOperations
