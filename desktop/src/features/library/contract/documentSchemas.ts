/** IPC schemas for documents, imports and their legacy task projection. */
import { resolvedMarkdownEditsSchema } from '@features/reader/contract/markdownEdits'
import { z } from 'zod'
import { boundedId, boundedPath, documentContent, documentFilename, documentProgress, documentTimestamp, documentUrl, noNul, safeName, timestamp, uuid } from '@platform/ipc/contract/validation'
import type { CopilotixTask } from './documentTypes'
import { translationProviderIdSchema, translatedMarkdownBlockSchema } from '@features/translation/contract/translationSchemas'
import { blockMappingSchema } from '@features/parsing/contract/blockSchemas'

export const taskStatusSchema = z.enum(['uploading', 'parsing', 'translating', 'partial', 'completed', 'failed'])

export const copilotixTaskSchema: z.ZodType<CopilotixTask> = z.object({
  id: boundedId,
  originalName: safeName,
  title: z.string().max(32_768).refine(noNul, '标题不能包含 NUL 字符').nullable(),
  titleSource: z.literal('pdf-metadata').optional(),
  name: safeName,
  sourcePath: boundedPath,
  sourceHash: z.string().min(1).max(512),
  outputDir: boundedPath,
  status: taskStatusSchema,
  progress: z.number().int().min(0).max(100),
  translationProvider: translationProviderIdSchema,
  remoteBatchId: z.string().max(4_096).nullable(),
  remoteDataId: z.string().max(4_096).nullable(),
  remoteResultUrl: z.string().max(8_192).nullable(),
  error: z.string().max(32_768).nullable(),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict()

export const documentWorkflowStatusSchema = z.enum(['queued', 'uploading', 'parsing', 'translating', 'partial', 'completed', 'failed'])
export type DocumentWorkflowStatus = z.infer<typeof documentWorkflowStatusSchema>

export const documentWorkflowSchema = z.object({
  status: documentWorkflowStatusSchema,
  progress: documentProgress,
  activeJobKind: z.enum(['parse', 'translate']).nullable(),
  translationProgress: z.object({
    totalBlocks: z.number().int().nonnegative(),
    completedBlocks: z.number().int().nonnegative(),
    failedBlocks: z.number().int().nonnegative()
  }).strict().optional(),
  error: z.string().max(32_768).refine(noNul, '错误信息不能包含 NUL 字符').nullable()
}).strict()

export const documentProcessingSchema = z.object({
  translationProvider: translationProviderIdSchema
}).strict()

export const documentSummarySchema = z.object({
  id: uuid,
  originalName: documentFilename,
  displayName: documentFilename,
  sourceHash: z.string().min(1).max(512).refine(noNul, '源文件摘要不能包含 NUL 字符'),
  workflow: documentWorkflowSchema,
  processing: documentProcessingSchema,
  createdAt: documentTimestamp,
  updatedAt: documentTimestamp
}).strict()
export type DocumentSummary = z.infer<typeof documentSummarySchema>

export const tutorialImportRequestSchema = z.object({ createDuplicate: z.boolean() }).strict()

export const documentChangeEventSchema = z.object({
  revision: z.number().int().positive(),
  upserted: z.array(documentSummarySchema).max(1_000),
  removedIds: z.array(uuid).max(1_000)
}).strict().superRefine((value, context) => {
  const upsertedIds = new Set(value.upserted.map((document) => document.id))
  const removedIds = new Set(value.removedIds)
  if (upsertedIds.size !== value.upserted.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['upserted'], message: 'upserted 文档 ID 必须唯一' })
  }
  if (removedIds.size !== value.removedIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['removedIds'], message: 'removedIds 必须唯一' })
  }
  for (const id of upsertedIds) {
    if (removedIds.has(id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['removedIds'], message: '同一文档不能同时 upsert 和 remove' })
      break
    }
  }
})
export type DocumentChangeEvent = z.infer<typeof documentChangeEventSchema>

export const documentDetailsSchema = z.object({
  summary: documentSummarySchema,
  markdown: documentContent,
  translatedMarkdown: documentContent,
  translatedBlocks: z.array(translatedMarkdownBlockSchema).max(100_000).nullable(),
  layoutJson: documentContent,
  mappings: z.array(blockMappingSchema).max(100_000),
  // Added with in-reader editing; older Main processes omit it.
  markdownEdits: resolvedMarkdownEditsSchema.nullable().optional(),
  pdfUrl: documentUrl,
  assetBaseUrl: documentUrl
}).strict()
export type DocumentDetails = z.infer<typeof documentDetailsSchema>

export const importDocumentsRequestSchema = z.object({
  createDuplicates: z.boolean().optional(),
  useOriginalFilename: z.boolean().optional()
}).strict()
export type ImportDocumentsRequest = z.infer<typeof importDocumentsRequestSchema>

/** Drag-and-drop accepts as many PDFs as the native file dialog does. */
export const MAX_IMPORT_PATHS = 2_000

// This request is used only between preload and main. `paths` is never part
// of the renderer-visible API or any response DTO.
// `files` (optional, added in 1.2.0) carries the confirmation's per-file choices in the order
// of `paths`. Requests without it import every file unchanged, as before.
export const importFileOptionsSchema = z.object({
  skipFirstPage: z.boolean().optional(),
  metadataTitle: z.string().max(4_096).refine(noNul, '标题不能包含 NUL 字符').optional()
}).strict()
export const importDocumentsIpcRequestSchema = z.object({
  options: importDocumentsRequestSchema,
  paths: z.array(boundedPath).max(MAX_IMPORT_PATHS).optional(),
  files: z.array(importFileOptionsSchema).max(MAX_IMPORT_PATHS).optional()
}).strict().refine((request) => request.files === undefined || request.files.length === request.paths?.length, {
  message: '导入选项必须与文件一一对应', path: ['files']
})

/** One unreadable or oversized PDF no longer aborts the rest of a selection. */
export const importDocumentsResultSchema = z.object({
  created: z.array(documentSummarySchema).max(MAX_IMPORT_PATHS),
  failed: z.array(z.object({ name: safeName, message: z.string().max(4_096) }).strict()).max(MAX_IMPORT_PATHS)
}).strict()
export type ImportDocumentsResult = z.infer<typeof importDocumentsResultSchema>

export const documentIdRequestSchema = uuid
export const deleteDocumentRequestSchema = z.object({
  documentId: uuid,
  deleteFiles: z.boolean()
}).strict()
export type DeleteDocumentRequest = z.infer<typeof deleteDocumentRequestSchema>

export const saveDocumentAsRequestSchema = z.object({
  documentId: uuid,
  kind: z.enum(['original-markdown', 'translated-markdown', 'result-zip'])
}).strict()
export type SaveDocumentAsRequest = z.infer<typeof saveDocumentAsRequestSchema>

export const saveDocumentAsResultSchema = z.object({ saved: z.boolean() }).strict()
export type SaveDocumentAsResult = z.infer<typeof saveDocumentAsResultSchema>
