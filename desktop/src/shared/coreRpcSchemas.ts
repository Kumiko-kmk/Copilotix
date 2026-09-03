import { z } from 'zod'
import {
  appSettingsSchema,
  documentAnnotationViewSchema,
  documentAnnotationKindSchema,
  documentSummarySchema,
  minerUTaskSchema,
  mutateReaderAnnotationsRequestSchema,
  readerAnnotationSnapshotSchema,
  replaceReaderAnnotationsRequestSchema,
  translationProviderIdSchema
} from './ipcSchemas'
import {
  translationPlanFinalizeResultSchema,
  translationPlanListResultSchema,
  translationPlanMutationResultSchema,
  translationPlanOpenResultSchema
} from './translationPlanProtocol'

/** The protocol is deliberately small and versioned before any data operation is added. */
export const CORE_RPC_VERSION = 1 as const
export const CORE_RPC_MAX_BYTES = 1024 * 1024

const noNul = (value: string): boolean => !value.includes('\0')
const requestIdSchema = z.string().uuid().refine(noNul, 'requestId cannot contain NUL')
const boundedTextSchema = z.string().min(1).max(32_768).refine(noNul, 'text cannot contain NUL')
const emptyPayloadSchema = z.object({}).strict()

export const coreRequestIdSchema = requestIdSchema

/**
 * Values crossing the process boundary are JSON values only. In particular, a
 * Buffer, typed array, ArrayBuffer, file handle, or stream must be represented by
 * a later operation-specific identifier rather than copied through RPC.
 */
function isRpcJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null) return true
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      return false
    default:
      break
  }

  if (typeof ArrayBuffer !== 'undefined' && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) return false
  if (typeof value !== 'object') return false

  const objectValue = value as object
  if (seen.has(objectValue)) return false
  seen.add(objectValue)
  try {
    if (value instanceof Date || value instanceof Map || value instanceof Set || value instanceof RegExp) return false
    if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return false

    if (Array.isArray(value)) return value.every((item) => isRpcJsonValue(item, seen))

    // Reject the common JSON representation produced by Buffer.toJSON().
    if (
      Object.prototype.hasOwnProperty.call(value, 'type') &&
      (value as { type?: unknown }).type === 'Buffer' &&
      Object.prototype.hasOwnProperty.call(value, 'data') &&
      Array.isArray((value as { data?: unknown }).data)
    ) return false

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    return Object.entries(value as Record<string, unknown>).every(([key, item]) => noNul(key) && isRpcJsonValue(item, seen))
  } finally {
    seen.delete(objectValue)
  }
}

export const coreJsonValueSchema = z.custom<unknown>(isRpcJsonValue, 'RPC values must be JSON-safe')

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

const corePathSchema = z.string().min(1).max(32_768).refine(noNul, 'path cannot contain NUL')
const coreIdSchema = z.string().min(1).max(512).refine(noNul, 'id cannot contain NUL')
const coreHashSchema = z.string().min(1).max(512).refine(noNul, 'hash cannot contain NUL')
const coreTimestampSchema = z.string().min(1).max(128).refine(noNul, 'timestamp cannot contain NUL')
const coreJobKindSchema = z.enum(['parse', 'translate'])
const coreJobStatusSchema = z.enum(['queued', 'running', 'retry-wait', 'succeeded', 'partial', 'failed', 'cancelled'])
export const coreTaskPatchSchema = z.object({
  originalName: z.string().min(1).max(32_768).refine(noNul).optional(),
  title: z.string().max(32_768).refine(noNul).nullable().optional(),
  name: z.string().min(1).max(32_768).refine(noNul).optional(),
  sourcePath: corePathSchema.optional(),
  sourceHash: coreHashSchema.optional(),
  outputDir: corePathSchema.optional(),
  status: z.enum(['uploading', 'parsing', 'translating', 'partial', 'completed', 'failed']).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  parserModel: z.enum(['vlm', 'pipeline']).optional(),
  translationProvider: translationProviderIdSchema.optional(),
  remoteBatchId: z.string().max(4_096).refine(noNul).nullable().optional(),
  remoteDataId: z.string().max(4_096).refine(noNul).nullable().optional(),
  remoteResultUrl: z.string().max(8_192).refine(noNul).nullable().optional(),
  error: z.string().max(32_768).refine(noNul).nullable().optional()
}).strict()
const coreMetadataSchema = z.record(z.string().max(512).refine(noNul), coreJsonValueSchema).refine((value) => Object.keys(value).length <= 128, 'metadata too large')
const coreArtifactKindSchema = z.enum([
  'source_pdf', 'parsed_markdown', 'layout', 'block_mappings', 'content_list', 'translated_markdown', 'manifest'
])
const coreTranslationBlockSchema = z.object({
  taskId: coreIdSchema,
  jobId: coreIdSchema.optional(),
  blockId: coreIdSchema,
  sourceHash: coreHashSchema,
  sourceMarkdown: z.string().max(262_144).refine(noNul),
  translatedMarkdown: z.string().max(262_144).refine(noNul).nullable(),
  provider: translationProviderIdSchema.nullable(),
  model: z.string().max(512).refine(noNul).nullable(),
  status: z.enum(['pending', 'completed', 'failed']),
  error: z.string().max(32_768).refine(noNul).nullable()
}).strict()
const coreTranslationBatchBlockSchema = z.object({
  blockId: coreIdSchema,
  sourceHash: coreHashSchema,
  sourceMarkdown: z.string().max(262_144).refine(noNul),
  translatedMarkdown: z.string().max(262_144).refine(noNul).nullable(),
  provider: translationProviderIdSchema.nullable(),
  model: z.string().max(512).refine(noNul).nullable(),
  status: z.enum(['pending', 'completed', 'failed']),
  error: z.string().max(32_768).refine(noNul).nullable()
}).strict()
const coreTranslationCacheEntrySchema = z.object({
  cacheKey: z.string().min(1).max(4_096).refine(noNul),
  translated: z.string().max(262_144).refine(noNul),
  provider: translationProviderIdSchema,
  model: z.string().max(512).refine(noNul)
}).strict()
const coreTranslationCheckpointSummarySchema = z.object({
  totalBlocks: z.number().int().min(0).max(100_000),
  completedBlocks: z.number().int().min(0).max(100_000),
  failedBlocks: z.number().int().min(0).max(100_000),
  failedBlockIds: z.array(coreIdSchema).max(64)
}).strict()
const coreReaderAnnotationSchema = z.object({
  id: coreIdSchema,
  taskId: coreIdSchema,
  view: documentAnnotationViewSchema,
  kind: documentAnnotationKindSchema,
  color: z.enum(['yellow', 'green', 'blue', 'pink', 'purple']).nullable(),
  blockKey: z.string().min(1).max(4_096).refine(noNul),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(1),
  quote: z.string().min(1).max(262_144).refine(noNul),
  prefix: z.string().max(256).refine(noNul),
  suffix: z.string().max(256).refine(noNul),
  createdAt: z.string().min(1).max(128).refine(noNul),
  updatedAt: z.string().min(1).max(128).refine(noNul)
}).strict()
const coreReaderAnnotationsSchema = z.array(coreReaderAnnotationSchema).max(10_000)

const coreOperationNames = [
  'ping', 'cancel', 'drain', 'shutdown',
  'database:init', 'database:flush', 'database:close',
  'settings:get', 'settings:save',
  'tasks:list', 'tasks:get', 'tasks:find-by-hash', 'tasks:insert', 'tasks:insert-many', 'tasks:update', 'tasks:delete',
  'jobs:enqueue', 'jobs:get', 'jobs:list', 'jobs:claim-batch', 'jobs:heartbeat', 'jobs:update-progress',
  'jobs:complete', 'jobs:fail-or-retry', 'jobs:cancel', 'jobs:manual-retry', 'jobs:recover-expired', 'jobs:list-events',
  'documents:list', 'documents:get-summary', 'documents:update-metadata', 'artifacts:get-latest', 'artifacts:record-revision',
  'translation:block-upsert', 'translation:batch-commit', 'translation:blocks-list', 'translation:run-update',
  'translation:cache-get', 'translation:cache-put',
  'annotations:list', 'annotations:replace', 'annotations:list-snapshot', 'annotations:mutate',
  'compute:hash-file', 'compute:import-pdf', 'compute:normalize-parser', 'compute:rebuild-mappings',
  'compute:translation-plan-open', 'compute:translation-plan-list', 'compute:translation-plan-cache',
  'compute:translation-plan-apply', 'compute:translation-plan-fail', 'compute:translation-plan-finalize'
] as const

export const coreOperationSchema = z.enum(coreOperationNames)
export type CoreOperation = z.infer<typeof coreOperationSchema>

export const corePingPayloadSchema = emptyPayloadSchema
export const corePingResultSchema = z.object({ pong: z.literal(true) }).strict()
export const coreCancelPayloadSchema = z.object({ requestId: requestIdSchema }).strict()
export const coreCancelResultSchema = z.object({ cancelled: z.boolean() }).strict()
export const coreDrainPayloadSchema = emptyPayloadSchema
export const coreDrainResultSchema = z.object({ drained: z.literal(true) }).strict()
export const coreShutdownPayloadSchema = emptyPayloadSchema
export const coreShutdownResultSchema = z.object({ shutdown: z.literal(true) }).strict()

export const coreDatabaseInitPayloadSchema = z.object({ databasePath: corePathSchema, outputRoot: corePathSchema }).strict()
export const coreDatabaseInitResultSchema = z.object({ initialized: z.literal(true) }).strict()
export const coreDatabaseFlushPayloadSchema = emptyPayloadSchema
export const coreDatabaseFlushResultSchema = z.object({ flushed: z.literal(true) }).strict()
export const coreDatabaseClosePayloadSchema = emptyPayloadSchema
export const coreDatabaseCloseResultSchema = z.object({ closed: z.literal(true) }).strict()
export const coreSettingsGetPayloadSchema = z.object({ outputRoot: corePathSchema }).strict()
export const coreSettingsGetResultSchema = appSettingsSchema
export const coreSettingsSavePayloadSchema = z.object({ settings: appSettingsSchema }).strict()
export const coreSettingsSaveResultSchema = appSettingsSchema
export const coreTasksListPayloadSchema = emptyPayloadSchema
export const coreTasksListResultSchema = z.array(minerUTaskSchema).max(10_000)
export const coreTaskIdPayloadSchema = z.object({ id: coreIdSchema }).strict()
export const coreTaskResultSchema = minerUTaskSchema.nullable()
export const coreFindTaskByHashPayloadSchema = z.object({ hash: coreHashSchema }).strict()
export const coreInsertTaskPayloadSchema = z.object({ task: minerUTaskSchema }).strict()
export const coreInsertTasksPayloadSchema = z.object({ tasks: z.array(minerUTaskSchema).max(100) }).strict()
export const coreMutationResultSchema = z.object({ changed: z.literal(true) }).strict()
export const coreUpdateTaskPayloadSchema = z.object({ id: coreIdSchema, patch: coreTaskPatchSchema }).strict()
export const coreDocumentMetadataPatchSchema = z.object({
  displayTitle: z.string().max(32_768).refine(noNul).nullable().optional()
}).strict()
export const coreDocumentMetadataPayloadSchema = z.object({
  id: coreIdSchema,
  patch: coreDocumentMetadataPatchSchema
}).strict()
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
  detail: coreJobJsonObjectSchema.optional()
}).strict()
export const coreJobRecoverExpiredPayloadSchema = z.object({ now: coreTimestampSchema }).strict()
export const coreJobEventsPayloadSchema = z.object({ jobId: coreIdSchema }).strict()
export const coreDocumentsListResultSchema = z.array(documentSummarySchema).max(10_000)
export const coreArtifactLatestPayloadSchema = z.object({ documentId: coreIdSchema, kind: coreArtifactKindSchema }).strict()
export const coreArtifactReferenceSchema = z.object({
  id: coreIdSchema,
  documentId: coreIdSchema,
  kind: coreArtifactKindSchema,
  revision: z.number().int().min(1),
  relativePath: corePathSchema,
  contentHash: coreHashSchema,
  metadata: coreMetadataSchema
}).strict()
export const coreArtifactLatestResultSchema = coreArtifactReferenceSchema.nullable()
export const coreArtifactRecordPayloadSchema = z.object({
  taskId: coreIdSchema,
  kind: coreArtifactKindSchema,
  path: corePathSchema,
  checksum: coreHashSchema,
  metadata: coreMetadataSchema.optional(),
  jobId: coreIdSchema.optional()
}).strict()
export const coreTranslationBlockUpsertPayloadSchema = z.object({ block: coreTranslationBlockSchema }).strict()
export const coreTranslationBatchCommitPayloadSchema = z.object({
  taskId: z.string().uuid().refine(noNul),
  jobId: z.string().uuid().refine(noNul),
  blocks: z.array(coreTranslationBatchBlockSchema).max(32),
  cacheEntries: z.array(coreTranslationCacheEntrySchema).max(32),
  checkpoint: coreTranslationCheckpointSummarySchema.optional()
}).strict().refine((value) => utf8ByteLength(JSON.stringify(value)) <= 768 * 1024, 'translation batch is too large')
export const coreTranslationBlocksListPayloadSchema = z.object({ taskId: coreIdSchema, jobId: coreIdSchema.optional() }).strict()
export const coreTranslationBlocksListResultSchema = z.array(coreTranslationBlockSchema).max(10_000)
export const coreTranslationRunUpdatePayloadSchema = z.object({
  taskId: coreIdSchema,
  total: z.number().int().min(0).max(100_000),
  completed: z.number().int().min(0).max(100_000),
  failed: z.number().int().min(0).max(100_000)
}).strict()
export const coreCacheGetPayloadSchema = z.object({ cacheKey: z.string().min(1).max(4_096).refine(noNul) }).strict()
export const coreCacheGetResultSchema = z.object({ translated: z.string().max(262_144).refine(noNul).nullable() }).strict()
export const coreCachePutPayloadSchema = z.object({
  cacheKey: z.string().min(1).max(4_096).refine(noNul),
  translated: z.string().max(262_144).refine(noNul),
  provider: translationProviderIdSchema,
  model: z.string().min(1).max(512).refine(noNul)
}).strict()
export const coreAnnotationsListPayloadSchema = z.object({ taskId: coreIdSchema }).strict()
export const coreAnnotationsListResultSchema = coreReaderAnnotationsSchema
export const coreAnnotationsReplacePayloadSchema = z.object({ request: replaceReaderAnnotationsRequestSchema }).strict()
export const coreAnnotationsReplaceResultSchema = coreReaderAnnotationsSchema
export const coreAnnotationsSnapshotPayloadSchema = z.object({ documentId: coreIdSchema, view: documentAnnotationViewSchema }).strict()
export const coreAnnotationsSnapshotResultSchema = readerAnnotationSnapshotSchema
export const coreAnnotationsMutatePayloadSchema = z.object({ request: mutateReaderAnnotationsRequestSchema }).strict()
export const coreAnnotationsMutateResultSchema = readerAnnotationSnapshotSchema
export const coreHashFilePayloadSchema = z.object({ path: corePathSchema }).strict()
export const coreHashFileResultSchema = z.object({ sha256: coreHashSchema }).strict()
export const coreImportPdfPayloadSchema = z.object({ sourcePath: corePathSchema, documentId: coreIdSchema }).strict()
export const coreImportPdfResultSchema = z.object({ sha256: coreHashSchema, size: z.number().int().min(0).max(200 * 1024 * 1024) }).strict()
export const coreNormalizeParserPayloadSchema = z.object({ task: minerUTaskSchema, extractedDir: corePathSchema, jobId: coreIdSchema.optional() }).strict()
export const coreNormalizeParserResultSchema = z.object({
  normalized: z.literal(true),
  displayTitle: z.string().max(32_768).refine(noNul).nullable()
}).strict()
export const coreRebuildMappingsPayloadSchema = z.object({ taskId: coreIdSchema, outputDir: corePathSchema }).strict()
export const coreRebuildMappingsResultSchema = z.object({ rebuilt: z.literal(true) }).strict()

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

/**
 * The registry is the only source of operation payload/result types. Later DB or
 * compute operations must add one entry here with strict schemas on both sides.
 */
export const coreOperationRegistry = {
  ping: { payload: corePingPayloadSchema, result: corePingResultSchema },
  cancel: { payload: coreCancelPayloadSchema, result: coreCancelResultSchema },
  drain: { payload: coreDrainPayloadSchema, result: coreDrainResultSchema },
  shutdown: { payload: coreShutdownPayloadSchema, result: coreShutdownResultSchema },
  'database:init': { payload: coreDatabaseInitPayloadSchema, result: coreDatabaseInitResultSchema },
  'database:flush': { payload: coreDatabaseFlushPayloadSchema, result: coreDatabaseFlushResultSchema },
  'database:close': { payload: coreDatabaseClosePayloadSchema, result: coreDatabaseCloseResultSchema },
  'settings:get': { payload: coreSettingsGetPayloadSchema, result: coreSettingsGetResultSchema },
  'settings:save': { payload: coreSettingsSavePayloadSchema, result: coreSettingsSaveResultSchema },
  'tasks:list': { payload: coreTasksListPayloadSchema, result: coreTasksListResultSchema },
  'tasks:get': { payload: coreTaskIdPayloadSchema, result: coreTaskResultSchema },
  'tasks:find-by-hash': { payload: coreFindTaskByHashPayloadSchema, result: coreTaskResultSchema },
  'tasks:insert': { payload: coreInsertTaskPayloadSchema, result: coreMutationResultSchema },
  'tasks:insert-many': { payload: coreInsertTasksPayloadSchema, result: coreMutationResultSchema },
  'tasks:update': { payload: coreUpdateTaskPayloadSchema, result: minerUTaskSchema },
  'tasks:delete': { payload: coreTaskIdPayloadSchema, result: coreMutationResultSchema },
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
  'jobs:list-events': { payload: coreJobEventsPayloadSchema, result: coreJobEventsResultSchema },
  'documents:list': { payload: coreTasksListPayloadSchema, result: coreDocumentsListResultSchema },
  'documents:get-summary': { payload: coreTaskIdPayloadSchema, result: documentSummarySchema.nullable() },
  'documents:update-metadata': { payload: coreDocumentMetadataPayloadSchema, result: coreMutationResultSchema },
  'artifacts:get-latest': { payload: coreArtifactLatestPayloadSchema, result: coreArtifactLatestResultSchema },
  'artifacts:record-revision': { payload: coreArtifactRecordPayloadSchema, result: coreMutationResultSchema },
  'translation:block-upsert': { payload: coreTranslationBlockUpsertPayloadSchema, result: coreMutationResultSchema },
  'translation:batch-commit': { payload: coreTranslationBatchCommitPayloadSchema, result: coreMutationResultSchema },
  'translation:blocks-list': { payload: coreTranslationBlocksListPayloadSchema, result: coreTranslationBlocksListResultSchema },
  'translation:run-update': { payload: coreTranslationRunUpdatePayloadSchema, result: coreMutationResultSchema },
  'translation:cache-get': { payload: coreCacheGetPayloadSchema, result: coreCacheGetResultSchema },
  'translation:cache-put': { payload: coreCachePutPayloadSchema, result: coreMutationResultSchema },
  'annotations:list': { payload: coreAnnotationsListPayloadSchema, result: coreAnnotationsListResultSchema },
  'annotations:replace': { payload: coreAnnotationsReplacePayloadSchema, result: coreAnnotationsReplaceResultSchema },
  'annotations:list-snapshot': { payload: coreAnnotationsSnapshotPayloadSchema, result: coreAnnotationsSnapshotResultSchema },
  'annotations:mutate': { payload: coreAnnotationsMutatePayloadSchema, result: coreAnnotationsMutateResultSchema },
  'compute:hash-file': { payload: coreHashFilePayloadSchema, result: coreHashFileResultSchema },
  'compute:import-pdf': { payload: coreImportPdfPayloadSchema, result: coreImportPdfResultSchema },
  'compute:normalize-parser': { payload: coreNormalizeParserPayloadSchema, result: coreNormalizeParserResultSchema },
  'compute:rebuild-mappings': { payload: coreRebuildMappingsPayloadSchema, result: coreRebuildMappingsResultSchema },
  'compute:translation-plan-open': { payload: coreTranslationPlanOpenPayloadSchema, result: coreTranslationPlanOpenResultSchema },
  'compute:translation-plan-list': { payload: coreTranslationPlanListPayloadSchema, result: coreTranslationPlanListResultSchema },
  'compute:translation-plan-cache': { payload: coreTranslationPlanCachePayloadSchema, result: coreTranslationPlanCacheResultSchema },
  'compute:translation-plan-apply': { payload: coreTranslationPlanApplyPayloadSchema, result: coreTranslationPlanApplyResultSchema },
  'compute:translation-plan-fail': { payload: coreTranslationPlanFailPayloadSchema, result: coreTranslationPlanFailResultSchema },
  'compute:translation-plan-finalize': { payload: coreTranslationPlanFinalizePayloadSchema, result: coreTranslationPlanFinalizeResultSchema }
} as const

export type CoreOperationPayload = {
  [K in CoreOperation]: z.infer<(typeof coreOperationRegistry)[K]['payload']>
}

export type CoreOperationResult = {
  [K in CoreOperation]: z.infer<(typeof coreOperationRegistry)[K]['result']>
}

export type CoreRequest = {
  [K in CoreOperation]: {
    version: typeof CORE_RPC_VERSION
    requestId: string
    operation: K
    payload: z.infer<(typeof coreOperationRegistry)[K]['payload']>
  }
}[CoreOperation]

const coreRequestVariants = (Object.entries(coreOperationRegistry) as Array<[CoreOperation, (typeof coreOperationRegistry)[CoreOperation]]>)
  .map(([operation, entry]) => z.object({
    version: z.literal(CORE_RPC_VERSION),
    requestId: requestIdSchema,
    operation: z.literal(operation),
    payload: entry.payload
  }).strict()) as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]

// The registry above is the authoritative runtime union. The cast only keeps
// Zod's tuple requirement out of the operation declaration; every variant is
// still strict and discriminated by `operation` at runtime.
export const coreRequestSchema = z.discriminatedUnion('operation', coreRequestVariants as any) as unknown as z.ZodType<CoreRequest>

export const coreErrorSchema = z.object({
  code: z.string().min(1).max(128).refine(noNul, 'error code cannot contain NUL'),
  message: boundedTextSchema,
  retryable: z.boolean()
}).strict()
export type CoreError = z.infer<typeof coreErrorSchema>

export const coreSuccessResponseSchema = z.object({
  version: z.literal(CORE_RPC_VERSION),
  requestId: requestIdSchema,
  ok: z.literal(true),
  value: coreJsonValueSchema
}).strict()

export const coreErrorResponseSchema = z.object({
  version: z.literal(CORE_RPC_VERSION),
  requestId: requestIdSchema,
  ok: z.literal(false),
  error: coreErrorSchema
}).strict()

/** Success and error are exact, mutually exclusive response envelopes. */
export const coreResponseSchema = z.discriminatedUnion('ok', [coreSuccessResponseSchema, coreErrorResponseSchema])
export type CoreResponse = z.infer<typeof coreResponseSchema>

const coreReadyEventSchema = z.object({ version: z.literal(CORE_RPC_VERSION), type: z.literal('ready'), payload: emptyPayloadSchema }).strict()
const coreDrainedEventSchema = z.object({ version: z.literal(CORE_RPC_VERSION), type: z.literal('drained'), payload: z.object({ drained: z.literal(true) }).strict() }).strict()
const coreShutdownEventSchema = z.object({ version: z.literal(CORE_RPC_VERSION), type: z.literal('shutdown'), payload: z.object({ shutdown: z.literal(true) }).strict() }).strict()
const coreErrorEventSchema = z.object({ version: z.literal(CORE_RPC_VERSION), type: z.literal('error'), payload: coreErrorSchema }).strict()

export const coreEventTypeSchema = z.enum(['ready', 'drained', 'shutdown', 'error'])
export type CoreEventType = z.infer<typeof coreEventTypeSchema>

export const coreEventSchema = z.discriminatedUnion('type', [
  coreReadyEventSchema,
  coreDrainedEventSchema,
  coreShutdownEventSchema,
  coreErrorEventSchema
])
export type CoreEvent = z.infer<typeof coreEventSchema>

export const coreMessageSchema = z.union([coreRequestSchema, coreResponseSchema, coreEventSchema])
export type CoreMessage = z.infer<typeof coreMessageSchema>

export class CoreRpcProtocolError extends Error {
  readonly code = 'CORE_PROTOCOL_ERROR' as const
  readonly retryable = false as const

  constructor(message = 'Core RPC protocol error') {
    super(message)
    this.name = 'CoreRpcProtocolError'
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error('undefined JSON')
    return serialized
  } catch {
    throw new CoreRpcProtocolError('Core RPC message is not serializable')
  }
}

function assertSize(value: unknown, message: string): void {
  if (!isRpcJsonValue(value)) throw new CoreRpcProtocolError('Core RPC message contains unsupported binary data')
  if (utf8ByteLength(safeStringify(value)) > CORE_RPC_MAX_BYTES) throw new CoreRpcProtocolError(message)
}

/** Validate and serialize a wire message with an explicit UTF-8 size bound. */
export function serializeCoreMessage(rawMessage: unknown): string {
  let message: CoreMessage
  try {
    message = coreMessageSchema.parse(rawMessage)
  } catch {
    throw new CoreRpcProtocolError('Core RPC message failed validation')
  }

  if ('payload' in message) assertSize(message.payload, 'Core RPC payload exceeds 1 MiB')
  assertSize(message, 'Core RPC envelope exceeds 1 MiB')
  return safeStringify(message)
}

/** Parse either Electron's structured-clone value or a serialized wire value. */
export function deserializeCoreMessage(rawMessage: unknown): CoreMessage {
  const raw = unwrapMessageEvent(rawMessage)
  let value: unknown = raw
  if (typeof raw === 'string') {
    if (utf8ByteLength(raw) > CORE_RPC_MAX_BYTES) throw new CoreRpcProtocolError('Core RPC envelope exceeds 1 MiB')
    try {
      value = JSON.parse(raw) as unknown
    } catch {
      throw new CoreRpcProtocolError('Core RPC message is not valid JSON')
    }
  }

  try {
    const message = coreMessageSchema.parse(value)
    if ('payload' in message) assertSize(message.payload, 'Core RPC payload exceeds 1 MiB')
    assertSize(message, 'Core RPC envelope exceeds 1 MiB')
    return message
  } catch (error) {
    if (error instanceof CoreRpcProtocolError) throw error
    throw new CoreRpcProtocolError('Core RPC message failed validation')
  }
}

export function validateCoreRequest(raw: unknown): CoreRequest {
  try {
    return coreRequestSchema.parse(raw)
  } catch {
    throw new CoreRpcProtocolError('Core RPC request failed validation')
  }
}

export function validateCoreOperationResult<K extends CoreOperation>(operation: K, value: unknown): CoreOperationResult[K] {
  try {
    return coreOperationRegistry[operation].result.parse(value) as CoreOperationResult[K]
  } catch {
    throw new CoreRpcProtocolError(`Core RPC result failed validation for ${operation}`)
  }
}

export function makeCoreErrorResponse(requestId: string, error: CoreError): CoreResponse {
  try {
    return coreErrorResponseSchema.parse({ version: CORE_RPC_VERSION, requestId, ok: false, error })
  } catch {
    throw new CoreRpcProtocolError('Core RPC error response failed validation')
  }
}

export function makeCoreSuccessResponse<K extends CoreOperation>(
  requestId: string,
  operation: K,
  value: CoreOperationResult[K]
): CoreResponse {
  const result = validateCoreOperationResult(operation, value)
  try {
    return coreSuccessResponseSchema.parse({ version: CORE_RPC_VERSION, requestId, ok: true, value: result })
  } catch {
    throw new CoreRpcProtocolError('Core RPC success response failed validation')
  }
}

export function makeCoreEvent(type: 'ready', payload?: CoreEvent['payload']): CoreEvent
export function makeCoreEvent(type: 'drained', payload?: CoreEvent['payload']): CoreEvent
export function makeCoreEvent(type: 'shutdown', payload?: CoreEvent['payload']): CoreEvent
export function makeCoreEvent(type: 'error', payload: CoreError): CoreEvent
export function makeCoreEvent(type: CoreEventType, payload: CoreEvent['payload'] = {}): CoreEvent {
  try {
    return coreEventSchema.parse({ version: CORE_RPC_VERSION, type, payload })
  } catch {
    throw new CoreRpcProtocolError('Core RPC event failed validation')
  }
}

function unwrapMessageEvent(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'data' in raw) return (raw as { data: unknown }).data
  return raw
}
