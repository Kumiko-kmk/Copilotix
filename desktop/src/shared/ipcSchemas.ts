import { z } from 'zod'
import type {
  AppSettings,
  BlockBox,
  BlockMapping,
  CreateTasksRequest,
  DeleteTaskRequest,
  DocumentPayload,
  HealthResult,
  MinerUTask,
  ReaderAnnotation,
  ReplaceReaderAnnotationsRequest,
  SaveAsRequest,
  SelectedPdf,
  SettingsUpdate,
  TranslatedMarkdownBlock,
  WindowState
} from './types'
import type { IpcError } from './ipc'

const noNul = (value: string): boolean => !value.includes('\0')
const boundedId = z.string().min(1).max(512).refine(noNul, '值不能包含 NUL 字符')
const boundedPath = z.string().min(1).max(32_768).refine(noNul, '路径不能包含 NUL 字符')
const safeName = z.string().min(1).max(32_768).refine(noNul, '名称不能包含 NUL 字符')
const timestamp = z.string().min(1).max(128)

export const parserModelSchema = z.enum(['vlm', 'pipeline'])
export const translationProviderIdSchema = z.enum(['qwen', 'deepseek', 'bing', 'transmart'])
export const taskStatusSchema = z.enum(['uploading', 'parsing', 'translating', 'partial', 'completed', 'failed'])

export const appSettingsSchema: z.ZodType<AppSettings> = z.object({
  hasParserToken: z.boolean(),
  outputRoot: boundedPath,
  parserModel: parserModelSchema,
  forceOcr: z.boolean(),
  formulaEnabled: z.boolean(),
  tableEnabled: z.boolean(),
  ocrLanguage: z.string().min(1).max(64),
  translationProvider: translationProviderIdSchema,
  qwenBaseUrl: z.string().min(1).max(2_048),
  qwenModel: z.string().min(1).max(512),
  qwenHasApiKey: z.boolean(),
  deepseekBaseUrl: z.string().min(1).max(2_048),
  deepseekModel: z.string().min(1).max(512),
  deepseekHasApiKey: z.boolean()
}).strict()

export const settingsUpdateSchema: z.ZodType<SettingsUpdate> = z.object({
  outputRoot: boundedPath,
  parserModel: parserModelSchema,
  forceOcr: z.boolean(),
  formulaEnabled: z.boolean(),
  tableEnabled: z.boolean(),
  ocrLanguage: z.string().min(1).max(64),
  translationProvider: translationProviderIdSchema,
  qwenBaseUrl: z.string().min(1).max(2_048),
  qwenModel: z.string().min(1).max(512),
  deepseekBaseUrl: z.string().min(1).max(2_048),
  deepseekModel: z.string().min(1).max(512),
  parserToken: z.string().max(16_384).optional(),
  clearParserToken: z.boolean().optional(),
  qwenApiKey: z.string().max(16_384).optional(),
  clearQwenApiKey: z.boolean().optional(),
  deepseekApiKey: z.string().max(16_384).optional(),
  clearDeepseekApiKey: z.boolean().optional()
}).strict()

export const healthResultSchema: z.ZodType<HealthResult> = z.object({
  ok: z.boolean(),
  message: z.string().max(16_384),
  code: z.union([z.string().max(512), z.number().finite()]).optional(),
  traceId: z.string().max(512).optional()
}).strict()

export const minerUTaskSchema: z.ZodType<MinerUTask> = z.object({
  id: boundedId,
  originalName: safeName,
  title: z.string().max(32_768).refine(noNul, '标题不能包含 NUL 字符').nullable(),
  name: safeName,
  sourcePath: boundedPath,
  sourceHash: z.string().min(1).max(512),
  outputDir: boundedPath,
  status: taskStatusSchema,
  progress: z.number().int().min(0).max(100),
  parserModel: parserModelSchema,
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

export const readerAnnotationSchema: z.ZodType<ReaderAnnotation> = z.object({
  id: boundedId,
  taskId: boundedId,
  view: z.enum(['original', 'translated']),
  kind: z.enum(['highlight', 'underline']),
  color: z.enum(['yellow', 'green', 'blue', 'pink', 'purple']).nullable(),
  blockKey: z.string().min(1).max(4_096),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(0),
  quote: z.string().max(1_000_000),
  prefix: z.string().max(1_000_000),
  suffix: z.string().max(1_000_000),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict()

export const selectedPdfSchema: z.ZodType<SelectedPdf> = z.object({
  path: boundedPath,
  name: safeName,
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  duplicateTask: minerUTaskSchema.optional()
}).strict()

export const createTasksRequestSchema: z.ZodType<CreateTasksRequest> = z.object({
  files: z.array(selectedPdfSchema).min(1).max(100),
  parserModel: parserModelSchema,
  translationProvider: translationProviderIdSchema,
  createDuplicates: z.boolean().optional()
}).strict()

export const deleteTaskRequestSchema: z.ZodType<DeleteTaskRequest> = z.object({
  taskId: boundedId,
  deleteFiles: z.boolean()
}).strict()

export const replaceReaderAnnotationsRequestSchema: z.ZodType<ReplaceReaderAnnotationsRequest> = z.object({
  taskId: boundedId,
  view: z.enum(['original', 'translated']),
  annotations: z.array(readerAnnotationSchema).max(10_000)
}).strict()

export const documentPayloadSchema: z.ZodType<DocumentPayload> = z.object({
  task: minerUTaskSchema,
  markdown: z.string().max(100_000_000),
  translatedMarkdown: z.string().max(100_000_000),
  translatedBlocks: z.array(translatedMarkdownBlockSchema).max(100_000).nullable(),
  layoutJson: z.string().max(100_000_000),
  mappings: z.array(blockMappingSchema).max(100_000),
  pdfUrl: z.string().min(1).max(8_192),
  assetBaseUrl: z.string().min(1).max(8_192)
}).strict()

export const saveAsRequestSchema: z.ZodType<SaveAsRequest> = z.object({
  taskId: boundedId,
  kind: z.enum(['original-markdown', 'translated-markdown', 'result-zip'])
}).strict()

export const windowActionSchema = z.enum(['minimize', 'toggle-maximize', 'close'])
export const windowStateSchema: z.ZodType<WindowState> = z.object({ maximized: z.boolean() }).strict()

export const parserTokenSchema = z.string().max(16_384).optional()
export const providerIdRequestSchema = translationProviderIdSchema
export const taskIdRequestSchema = boundedId
export const inspectPdfsRequestSchema = z.array(boundedPath).max(100)
export const noRequestSchema = z.undefined()
export const outputDirectorySchema = z.string().max(32_768).nullable()
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
