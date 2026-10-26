import { z } from 'zod'
import { documentSummarySchema, copilotixTaskSchema } from './documentSchemas'
import { coreHashSchema, coreIdSchema, coreJsonValueSchema, corePathSchema, coreTimestampSchema, emptyPayloadSchema, noNul } from '@platform/rpc/contract/protocol'
import { libraryCategoriesPageSchema, libraryCategoriesRequestSchema } from './libraryCategories'
import { libraryCoreRequestSchema, libraryResultSchema } from './librarySchemas'

export const coreMetadataSchema = z.record(z.string().max(512).refine(noNul), coreJsonValueSchema).refine((value) => Object.keys(value).length <= 128, 'metadata too large')

export const coreArtifactKindSchema = z.enum([
  'source_pdf', 'parsed_markdown', 'layout', 'block_mappings', 'content_list', 'translated_markdown', 'manifest'
])

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

export const coreHashFilePayloadSchema = z.object({ path: corePathSchema }).strict()
export const coreHashFileResultSchema = z.object({ sha256: coreHashSchema }).strict()

// skipFirstPage (optional, 1.2.0): drop page 1 while publishing original.pdf; absent keeps the bytes unchanged.
export const coreImportPdfPayloadSchema = z.object({ sourcePath: corePathSchema, documentId: coreIdSchema, skipFirstPage: z.boolean().optional() }).strict()

export const coreImportPdfResultSchema = z.object({ sha256: coreHashSchema, size: z.number().int().min(0).max(200 * 1024 * 1024) }).strict()

/** Core RPC operations of the document library: tasks and document summaries (keyset-paged), artifact revisions, PDF import, categories and maintenance. */
export const libraryOperations = {
  'tasks:list': { payload: coreListPagePayloadSchema, result: coreTasksListResultSchema },
  'tasks:get': { payload: coreTaskIdPayloadSchema, result: coreTaskResultSchema },
  'tasks:find-by-hash': { payload: coreFindTaskByHashPayloadSchema, result: coreTaskResultSchema },
  'tasks:insert-many': { payload: coreInsertTasksPayloadSchema, result: coreMutationResultSchema },
  'tasks:delete': { payload: coreTaskIdPayloadSchema, result: coreMutationResultSchema },
  'documents:list': { payload: coreListPagePayloadSchema, result: coreDocumentsListResultSchema },
  'documents:get-summary': { payload: coreTaskIdPayloadSchema, result: documentSummarySchema.nullable() },
  'documents:update-metadata': { payload: coreDocumentMetadataPayloadSchema, result: coreMutationResultSchema },
  'artifacts:record-revision': { payload: coreArtifactRecordPayloadSchema, result: coreMutationResultSchema },
  'compute:hash-file': { payload: coreHashFilePayloadSchema, result: coreHashFileResultSchema },
  'compute:import-pdf': { payload: coreImportPdfPayloadSchema, result: coreImportPdfResultSchema },
  'compute:library-categories': { payload: libraryCategoriesRequestSchema, result: libraryCategoriesPageSchema },
  'library:check': { payload: emptyPayloadSchema, result: z.object({ idle: z.literal(true) }).strict() },
  'library:manage': { payload: libraryCoreRequestSchema, result: libraryResultSchema }
} as const
export type LibraryOperations = typeof libraryOperations
