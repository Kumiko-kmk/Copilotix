import { briefSourceSchema, paperBriefSaveSchema } from '@shared/paperBrief/contracts'
import { paperChatFigureRequestSchema, paperChatFigureSourceSchema } from './paperChatFigures'
import { markdownEditRequestSchema, markdownEditResultSchema } from './markdownEdits'
import { figureInsightRequestSchema, figureInsightStateSchema, figureInsightDescriptorSchema, figureInsightSaveSchema } from './figureInsight'
import { paperInsightRequestSchema, paperInsightStateSchema, paperInsightSavedSchema } from './paperInsight'
import { libraryCategoriesRequestSchema, libraryCategoriesPageSchema } from './libraryCategories'
import { paperChatStatusRequestSchema, paperChatStatusSchema, paperContextRequestSchema, paperContextResultSchema } from './paperChatSchemas'
import { paperChatDeleteTurnSchema, paperChatDeletedSchema, paperChatDocumentRequestSchema, paperChatLoadRequestSchema, paperChatPageSchema, paperChatSaveTurnSchema, paperChatSaveSessionSchema, paperChatSessionSchema, paperChatSavedSchema, paperChatClearedSchema } from './paperChatStorageSchemas'
import { readerNoteDeleteSchema, readerNoteUpsertSchema, readerNotesRequestSchema, readerNotesSchema } from './readerNotes'
import { z } from 'zod'
import { libraryCoreRequestSchema, libraryResultSchema } from './librarySchemas'
import {
  appSettingsSchema,
  documentAnnotationViewSchema,
  documentSummarySchema,
  copilotixTaskSchema,
  mutateReaderAnnotationsRequestSchema,
  readerAnnotationSnapshotSchema,
  translationProviderIdSchema
} from './ipcSchemas'
import {
  translationPlanFinalizeResultSchema,
  translationPlanListResultSchema,
  translationPlanMutationResultSchema,
  translationPlanOpenResultSchema
} from './translationPlanProtocol'

import { coreHashSchema, coreIdSchema, coreJsonValueSchema, corePathSchema, coreTimestampSchema, emptyPayloadSchema, noNul } from '@platform/rpc/contract/protocol'

const coreMetadataSchema = z.record(z.string().max(512).refine(noNul), coreJsonValueSchema).refine((value) => Object.keys(value).length <= 128, 'metadata too large')
const coreArtifactKindSchema = z.enum([
  'source_pdf', 'parsed_markdown', 'layout', 'block_mappings', 'content_list', 'translated_markdown', 'manifest'
])

export const coreSettingsGetPayloadSchema = z.object({ outputRoot: corePathSchema }).strict()
export const coreSettingsGetResultSchema = appSettingsSchema
export const coreSettingsSavePayloadSchema = z.object({ settings: appSettingsSchema }).strict()
export const coreSettingsSaveResultSchema = appSettingsSchema
export const coreSettingsMigrationPayloadSchema = z.object({ id: coreIdSchema }).strict()
export const coreSettingsMigrationGetResultSchema = z.object({ applied: z.boolean() }).strict()
export const coreSettingsMigrationMarkResultSchema = z.object({ applied: z.literal(true) }).strict()
/**
 * Library listings are keyset-paged so a large library never exceeds the
 * 1 MiB RPC envelope. `after` is the last row of the previous page; the
 * Utility trims each page to a byte budget and returns the next cursor.
 */
export const CORE_LIST_PAGE_MAX_ROWS = 200
export const coreListCursorSchema = z.object({ createdAt: coreTimestampSchema, id: coreIdSchema }).strict()
export type CoreListCursor = z.infer<typeof coreListCursorSchema>
export const coreListPagePayloadSchema = z.object({ after: coreListCursorSchema.optional() }).strict()
export const coreTasksListResultSchema = z.object({
  items: z.array(copilotixTaskSchema).max(CORE_LIST_PAGE_MAX_ROWS),
  next: coreListCursorSchema.nullable()
}).strict()
export const coreTaskIdPayloadSchema = z.object({ id: coreIdSchema }).strict()
export const coreTaskResultSchema = copilotixTaskSchema.nullable()
export const coreFindTaskByHashPayloadSchema = z.object({ hash: coreHashSchema }).strict()
export const coreInsertTasksPayloadSchema = z.object({ tasks: z.array(copilotixTaskSchema).max(100) }).strict()
export const coreMutationResultSchema = z.object({ changed: z.literal(true) }).strict()
export const coreDocumentMetadataPatchSchema = z.object({
  displayTitle: z.string().max(32_768).refine(noNul).nullable().optional()
}).strict()
export const coreDocumentMetadataPayloadSchema = z.object({
  id: coreIdSchema,
  patch: coreDocumentMetadataPatchSchema
}).strict()
export const coreDocumentsListResultSchema = z.object({
  items: z.array(documentSummarySchema).max(CORE_LIST_PAGE_MAX_ROWS),
  next: coreListCursorSchema.nullable()
}).strict()
export const coreArtifactRecordPayloadSchema = z.object({
  taskId: coreIdSchema,
  kind: coreArtifactKindSchema,
  path: corePathSchema,
  checksum: coreHashSchema,
  metadata: coreMetadataSchema.optional(),
  jobId: coreIdSchema.optional()
}).strict()
export const coreAnnotationsSnapshotPayloadSchema = z.object({ documentId: coreIdSchema, view: documentAnnotationViewSchema }).strict()
export const coreAnnotationsSnapshotResultSchema = readerAnnotationSnapshotSchema
export const coreAnnotationsMutatePayloadSchema = z.object({ request: mutateReaderAnnotationsRequestSchema }).strict()
export const coreAnnotationsMutateResultSchema = readerAnnotationSnapshotSchema
export const coreHashFilePayloadSchema = z.object({ path: corePathSchema }).strict()
export const coreHashFileResultSchema = z.object({ sha256: coreHashSchema }).strict()
// skipFirstPage (optional, 1.2.0): drop page 1 while publishing original.pdf; absent keeps the bytes unchanged.
export const coreImportPdfPayloadSchema = z.object({ sourcePath: corePathSchema, documentId: coreIdSchema, skipFirstPage: z.boolean().optional() }).strict()
export const coreImportPdfResultSchema = z.object({ sha256: coreHashSchema, size: z.number().int().min(0).max(200 * 1024 * 1024) }).strict()
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
export const coreRagContentIndexPayloadSchema = z.object({
  documentId: coreIdSchema,
  contentRevisionId: coreIdSchema
}).strict()
export const coreRagContentIndexResultSchema = z.object({
  documentId: coreIdSchema,
  contentRevisionId: coreIdSchema,
  chunkCount: z.number().int().min(0).max(100_000),
  revisionState: z.literal('ready')
}).strict()

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
 * Feature operations still declared here until each module owns its contract (milestone M4).
 * The app registry (`app/contract/coreRpc.ts`) combines them with platform and job operations.
 */
export const featureOperations = {
  'figureInsight:get': { payload: figureInsightRequestSchema, result: figureInsightStateSchema },
  'compute:figure-insight-descriptor': { payload: figureInsightRequestSchema, result: figureInsightDescriptorSchema },
  'figureInsight:save': { payload: figureInsightSaveSchema, result: z.object({ saved: z.literal(true) }).strict() },
  'insight:get': { payload: paperInsightRequestSchema, result: paperInsightStateSchema },
  'insight:save-brief': { payload: paperBriefSaveSchema, result: paperInsightSavedSchema },
  'insight:brief-source': { payload: paperInsightRequestSchema, result: briefSourceSchema },
  'compute:library-categories': { payload: libraryCategoriesRequestSchema, result: libraryCategoriesPageSchema },
  'chat:load': { payload: paperChatLoadRequestSchema, result: paperChatPageSchema },
  'chat:save-turn': { payload: paperChatSaveTurnSchema, result: paperChatSavedSchema },
  'chat:session': { payload: paperChatDocumentRequestSchema, result: paperChatSessionSchema },
  'chat:save-session': { payload: paperChatSaveSessionSchema, result: paperChatSavedSchema },
  'notes:list': { payload: readerNotesRequestSchema, result: readerNotesSchema },
  'notes:upsert': { payload: readerNoteUpsertSchema, result: readerNotesSchema },
  'notes:delete': { payload: readerNoteDeleteSchema, result: readerNotesSchema },
  'chat:delete-turn': { payload: paperChatDeleteTurnSchema, result: paperChatDeletedSchema },
  'chat:clear': { payload: paperChatDocumentRequestSchema, result: paperChatClearedSchema },
  'chat:ensure-index': { payload: paperChatStatusRequestSchema, result: paperChatStatusSchema },
  'chat:build-context': { payload: paperContextRequestSchema, result: paperContextResultSchema },
  'markdown-edits:apply': { payload: markdownEditRequestSchema, result: markdownEditResultSchema },
  'compute:paper-chat-figure': { payload: paperChatFigureRequestSchema, result: paperChatFigureSourceSchema },
  'library:check': { payload: emptyPayloadSchema, result: z.object({ idle: z.literal(true) }).strict() },
  'library:manage': { payload: libraryCoreRequestSchema, result: libraryResultSchema },
  'settings:get': { payload: coreSettingsGetPayloadSchema, result: coreSettingsGetResultSchema },
  'settings:save': { payload: coreSettingsSavePayloadSchema, result: coreSettingsSaveResultSchema },
  'settings:migration-get': { payload: coreSettingsMigrationPayloadSchema, result: coreSettingsMigrationGetResultSchema },
  'settings:migration-mark': { payload: coreSettingsMigrationPayloadSchema, result: coreSettingsMigrationMarkResultSchema },
  'tasks:list': { payload: coreListPagePayloadSchema, result: coreTasksListResultSchema },
  'tasks:get': { payload: coreTaskIdPayloadSchema, result: coreTaskResultSchema },
  'tasks:find-by-hash': { payload: coreFindTaskByHashPayloadSchema, result: coreTaskResultSchema },
  'tasks:insert-many': { payload: coreInsertTasksPayloadSchema, result: coreMutationResultSchema },
  'tasks:delete': { payload: coreTaskIdPayloadSchema, result: coreMutationResultSchema },
  'documents:list': { payload: coreListPagePayloadSchema, result: coreDocumentsListResultSchema },
  'documents:get-summary': { payload: coreTaskIdPayloadSchema, result: documentSummarySchema.nullable() },
  'documents:update-metadata': { payload: coreDocumentMetadataPayloadSchema, result: coreMutationResultSchema },
  'artifacts:record-revision': { payload: coreArtifactRecordPayloadSchema, result: coreMutationResultSchema },
  'annotations:list-snapshot': { payload: coreAnnotationsSnapshotPayloadSchema, result: coreAnnotationsSnapshotResultSchema },
  'annotations:mutate': { payload: coreAnnotationsMutatePayloadSchema, result: coreAnnotationsMutateResultSchema },
  'compute:hash-file': { payload: coreHashFilePayloadSchema, result: coreHashFileResultSchema },
  'compute:import-pdf': { payload: coreImportPdfPayloadSchema, result: coreImportPdfResultSchema },
  'compute:normalize-parser': { payload: coreNormalizeParserPayloadSchema, result: coreNormalizeParserResultSchema },
  'compute:rebuild-mappings': { payload: coreRebuildMappingsPayloadSchema, result: coreRebuildMappingsResultSchema },
  'compute:repair-text-layer': { payload: coreRepairTextLayerPayloadSchema, result: coreRepairTextLayerResultSchema },
  'compute:rag-content-index': { payload: coreRagContentIndexPayloadSchema, result: coreRagContentIndexResultSchema },
  'compute:translation-plan-open': { payload: coreTranslationPlanOpenPayloadSchema, result: coreTranslationPlanOpenResultSchema },
  'compute:translation-plan-list': { payload: coreTranslationPlanListPayloadSchema, result: coreTranslationPlanListResultSchema },
  'compute:translation-plan-cache': { payload: coreTranslationPlanCachePayloadSchema, result: coreTranslationPlanCacheResultSchema },
  'compute:translation-plan-apply': { payload: coreTranslationPlanApplyPayloadSchema, result: coreTranslationPlanApplyResultSchema },
  'compute:translation-plan-fail': { payload: coreTranslationPlanFailPayloadSchema, result: coreTranslationPlanFailResultSchema },
  'compute:translation-plan-finalize': { payload: coreTranslationPlanFinalizePayloadSchema, result: coreTranslationPlanFinalizeResultSchema }
} as const
