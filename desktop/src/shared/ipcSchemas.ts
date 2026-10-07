import { paperChatProviderSchema, qwenChatModelSchema, deepseekChatModelSchema } from './paperChatSchemas'
import { z } from 'zod'
import type {
  AppSettings,
  BlockBox,
  BlockMapping,
  CopilotixTask,
  CredentialFieldError,
  CredentialMutation,
  CredentialName,
  CredentialStatus,
  CredentialStatuses,
  CredentialValidationResult,
  SettingsUpdate,
  SettingsSaveResult,
  TranslatedMarkdownBlock,
  WindowState
} from './types'
import type { IpcError } from './ipc'

const noNul = (value: string): boolean => !value.includes('\0')
const hasControlCharacters = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}
const boundedId = z.string().min(1).max(512).refine(noNul, '值不能包含 NUL 字符')
const boundedPath = z.string().min(1).max(32_768).refine(noNul, '路径不能包含 NUL 字符')
const safeName = z.string().min(1).max(32_768).refine(noNul, '名称不能包含 NUL 字符')
const timestamp = z.string().min(1).max(128)

export const translationProviderIdSchema = z.enum(['qwen', 'deepseek', 'bing', 'transmart'])
export const taskStatusSchema = z.enum(['uploading', 'parsing', 'translating', 'partial', 'completed', 'failed'])

export const credentialNameSchema: z.ZodType<CredentialName> = z.enum(['parser', 'qwen', 'deepseek'])
const credentialValueSchema = z.string()
  .trim()
  .min(1, '凭据不能为空')
  .max(16_384, '凭据过长')
  .refine(noNul, '凭据不能包含 NUL 字符')
  .refine((value) => !hasControlCharacters(value), '凭据不能包含控制字符')
const credentialMutationSchema: z.ZodType<CredentialMutation> = z.union([
  z.object({ action: z.literal('set'), value: credentialValueSchema }).strict(),
  z.object({ action: z.literal('clear') }).strict()
])
export const credentialStatusesSchema: z.ZodType<CredentialStatuses> = z.object({
  parser: credentialStatusSchemaPlaceholder(),
  qwen: credentialStatusSchemaPlaceholder(),
  deepseek: credentialStatusSchemaPlaceholder()
}).strict()

const translationProviderOrderSchema = z.array(translationProviderIdSchema).length(4).refine(
  (providers) => new Set(providers).size === 4,
  '翻译模型顺序必须完整且不能重复'
)
const enabledTranslationProvidersSchema = z.array(translationProviderIdSchema).min(1).max(4).refine(
  (providers) => new Set(providers).size === providers.length,
  '启用的翻译模型不能重复'
)

function credentialStatusSchemaPlaceholder(): z.ZodType<CredentialStatus> {
  return z.object({
    state: z.enum(['missing', 'unknown', 'valid', 'invalid']),
    maskedValue: z.string().max(256).refine(noNul).optional(),
    errorCode: z.string().max(128).refine(noNul).optional(),
    message: z.string().max(1_024).refine(noNul).optional()
  }).strict()
}

const credentialFieldErrorSchema: z.ZodType<CredentialFieldError> = z.object({
  code: z.string().min(1).max(128).refine(noNul),
  message: z.string().min(1).max(1_024).refine(noNul)
}).strict()

export const credentialValidationResultSchema: z.ZodType<CredentialValidationResult> = z.object({
  state: z.enum(['missing', 'unknown', 'valid', 'invalid']),
  errorCode: z.string().max(128).refine(noNul).optional(),
  message: z.string().max(1_024).refine(noNul).optional()
}).strict()

export const credentialValidationRequestSchema = z.object({
  name: credentialNameSchema,
  value: credentialValueSchema.optional()
}).strict()

export const appSettingsSchema: z.ZodType<AppSettings> = z.object({
  outputRoot: boundedPath,
  formulaEnabled: z.boolean(),
  tableEnabled: z.boolean(),
  translationProvider: translationProviderIdSchema,
  translationProviderOrder: translationProviderOrderSchema,
  enabledTranslationProviders: enabledTranslationProvidersSchema,
  qwenBaseUrl: z.string().min(1).max(2_048),
  qwenModel: z.string().min(1).max(512),
  deepseekBaseUrl: z.string().min(1).max(2_048),
  deepseekModel: z.string().min(1).max(512),
  chatProvider: paperChatProviderSchema.nullable().default(null),
  qwenChatModel: qwenChatModelSchema.default('qwen-plus').catch('qwen-plus'),
  deepseekChatModel: deepseekChatModelSchema.default('deepseek-flash').catch('deepseek-flash'),
  chatConsentProvider: paperChatProviderSchema.nullable().default(null),
  chatConsentVersion: z.number().int().min(1).max(1000).nullable().default(null),
  credentials: credentialStatusesSchema
}).strict().refine(
  (settings) => settings.translationProviderOrder.find((provider) => settings.enabledTranslationProviders.includes(provider)) === settings.translationProvider,
  '首选翻译模型必须是顺序中第一个已启用模型'
)

export const settingsUpdateSchema: z.ZodType<SettingsUpdate> = z.object({
  outputRoot: boundedPath,
  formulaEnabled: z.boolean(),
  tableEnabled: z.boolean(),
  translationProvider: translationProviderIdSchema,
  translationProviderOrder: translationProviderOrderSchema,
  enabledTranslationProviders: enabledTranslationProvidersSchema,
  qwenBaseUrl: z.string().min(1).max(2_048),
  qwenModel: z.string().min(1).max(512),
  deepseekBaseUrl: z.string().min(1).max(2_048),
  deepseekModel: z.string().min(1).max(512),
  chatProvider: paperChatProviderSchema.nullable().default(null),
  qwenChatModel: qwenChatModelSchema.default('qwen-plus'),
  deepseekChatModel: deepseekChatModelSchema.default('deepseek-flash'),
  chatConsentProvider: paperChatProviderSchema.nullable().default(null),
  chatConsentVersion: z.number().int().min(1).max(1000).nullable().default(null),
  credentialMutations: z.object({
    parser: credentialMutationSchema.optional(),
    qwen: credentialMutationSchema.optional(),
    deepseek: credentialMutationSchema.optional()
  }).strict().optional()
}).strict().refine(
  (settings) => settings.translationProviderOrder.find((provider) => settings.enabledTranslationProviders.includes(provider)) === settings.translationProvider,
  '首选翻译模型必须是顺序中第一个已启用模型'
)

export const settingsSaveResultSchema: z.ZodType<SettingsSaveResult> = z.object({
  settings: appSettingsSchema,
  fieldErrors: z.object({
    parser: credentialFieldErrorSchema.optional(),
    qwen: credentialFieldErrorSchema.optional(),
    deepseek: credentialFieldErrorSchema.optional()
  }).strict()
}).strict()

export const copilotixTaskSchema: z.ZodType<CopilotixTask> = z.object({
  id: boundedId,
  originalName: safeName,
  title: z.string().max(32_768).refine(noNul, '标题不能包含 NUL 字符').nullable(),
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

export const translatedMarkdownBlockSchema: z.ZodType<TranslatedMarkdownBlock> = z.object({
  sourceIndex: z.number().int().min(0).optional(),
  markdown: z.string().max(16_777_216),
  mappingIds: z.array(boundedId).max(100_000)
}).strict()

export const windowActionSchema = z.enum(['minimize', 'toggle-maximize', 'close'])
export const windowStateSchema: z.ZodType<WindowState> = z.object({ maximized: z.boolean() }).strict()

export const noRequestSchema = z.undefined()
export const outputDirectorySchema = z.string().max(32_768).nullable()

export const storageCategorySchema = z.object({
  kind: z.enum(['source', 'image', 'translation', 'other']),
  fileCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
}).strict()
export type StorageCategory = z.infer<typeof storageCategorySchema>
export const storageGrowthPointSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
}).strict()
export type StorageGrowthPoint = z.infer<typeof storageGrowthPointSchema>
export const storageInfoSchema = z.object({
  rootPath: boundedPath,
  exists: z.boolean(),
  documentCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  fileCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  categories: z.array(storageCategorySchema).length(4),
  growth: z.array(storageGrowthPointSchema).length(14)
}).strict()
export type StorageInfo = z.infer<typeof storageInfoSchema>
export const usageAnalyticsDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  documents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  pages: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  deepseekTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  qwenTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
}).strict()
export type UsageAnalyticsDay = z.infer<typeof usageAnalyticsDaySchema>
export const usageAnalyticsSchema = z.object({
  days: z.array(usageAnalyticsDaySchema).min(1).max(366)
}).strict()
export type UsageAnalytics = z.infer<typeof usageAnalyticsSchema>
export const voidResponseSchema = z.undefined()

export const ipcErrorSchema: z.ZodType<IpcError> = z.object({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(32_768),
  retryable: z.boolean(),
  traceId: z.string().max(512).optional()
}).strict()

export function ipcEnvelopeSchema<T extends z.ZodType>(valueSchema: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: valueSchema }).strict(),
    z.object({ ok: z.literal(false), error: ipcErrorSchema }).strict()
  ])
}

/*
 * Document IPC contracts
 *
 * These schemas are the only source of truth for the v2 document API.  The
 * legacy task contracts above remain in place for the temporary compatibility
 * adapter, but no local filesystem path is part of any contract below.
 */
const uuid = z.string().uuid().refine(noNul, '值不能包含 NUL 字符')
const documentFilename = z.string().min(1).max(1_024).refine(noNul, '文件名不能包含 NUL 字符')
const documentContent = z.string().max(100_000_000).refine(noNul, '内容不能包含 NUL 字符')
const documentUrl = z.string().min(1).max(8_192).refine(noNul, '地址不能包含 NUL 字符')
const documentTimestamp = z.string().min(1).max(128).refine(noNul, '时间不能包含 NUL 字符')
const documentProgress = z.number().int().min(0).max(100)

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
export const importDocumentsIpcRequestSchema = z.object({
  options: importDocumentsRequestSchema,
  paths: z.array(boundedPath).max(MAX_IMPORT_PATHS).optional()
}).strict()

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

export const documentAnnotationViewSchema = z.enum(['original', 'translated'])
export const documentAnnotationKindSchema = z.enum(['highlight', 'underline'])
export const documentHighlightColorSchema = z.enum(['yellow', 'green', 'blue', 'pink', 'purple'])

export const documentAnnotationSchema = z.object({
  id: uuid,
  documentId: uuid,
  artifactId: uuid,
  view: documentAnnotationViewSchema,
  kind: documentAnnotationKindSchema,
  color: documentHighlightColorSchema.nullable(),
  blockKey: z.string().min(1).max(4_096).refine(noNul, '区块键不能包含 NUL 字符'),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(1),
  quote: z.string().min(1).max(1_000_000).refine(noNul, '引用不能包含 NUL 字符'),
  prefix: z.string().max(256).refine(noNul, '前缀不能包含 NUL 字符'),
  suffix: z.string().max(256).refine(noNul, '后缀不能包含 NUL 字符'),
  createdAt: documentTimestamp,
  updatedAt: documentTimestamp
}).strict().superRefine((value, context) => {
  if (value.endOffset <= value.startOffset) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['endOffset'], message: '结束偏移必须大于起始偏移' })
  }
  if (value.quote.length !== value.endOffset - value.startOffset) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['quote'], message: '引用长度必须匹配偏移范围' })
  }
  if (value.kind === 'underline' && value.color !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['color'], message: '下划线标注不能设置颜色' })
  }
})
export type DocumentAnnotation = z.infer<typeof documentAnnotationSchema>

export const listReaderAnnotationsRequestSchema = z.object({
  documentId: uuid,
  view: documentAnnotationViewSchema
}).strict()
export type ListReaderAnnotationsRequest = z.infer<typeof listReaderAnnotationsRequestSchema>

export const readerAnnotationSnapshotSchema = z.object({
  documentId: uuid,
  artifactId: uuid,
  view: documentAnnotationViewSchema,
  revision: z.number().int().min(0),
  annotations: z.array(documentAnnotationSchema).max(50_000)
}).strict()
export type ReaderAnnotationSnapshot = z.infer<typeof readerAnnotationSnapshotSchema>

export const mutateReaderAnnotationsRequestSchema = z.object({
  documentId: uuid,
  artifactId: uuid,
  view: documentAnnotationViewSchema,
  expectedRevision: z.number().int().min(0),
  upserts: z.array(documentAnnotationSchema).max(50_000),
  deleteIds: z.array(uuid).max(50_000)
}).strict().superRefine((value, context) => {
  const upsertIds = new Set(value.upserts.map((annotation) => annotation.id))
  const deleteIds = new Set(value.deleteIds)
  if (upsertIds.size !== value.upserts.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['upserts'], message: 'upserts 标注 ID 必须唯一' })
  }
  if (deleteIds.size !== value.deleteIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['deleteIds'], message: 'deleteIds 必须唯一' })
  }
  for (const id of upsertIds) {
    if (deleteIds.has(id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['deleteIds'], message: 'upsert 和 delete 不能包含同一标注' })
      break
    }
  }
  for (const [index, annotation] of value.upserts.entries()) {
    if (annotation.documentId !== value.documentId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['upserts', index, 'documentId'], message: '标注文档不匹配' })
    }
    if (annotation.artifactId !== value.artifactId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['upserts', index, 'artifactId'], message: '标注产物不匹配' })
    }
    if (annotation.view !== value.view) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['upserts', index, 'view'], message: '标注视图不匹配' })
    }
  }
})
export type MutateReaderAnnotationsRequest = z.infer<typeof mutateReaderAnnotationsRequestSchema>

