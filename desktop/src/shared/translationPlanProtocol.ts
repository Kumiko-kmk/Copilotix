import { z } from 'zod'
import type { TranslationProviderId } from './types'

/** Versions are part of the on-disk plan identity. Do not change casually. */
export const TRANSLATION_PIPELINE_VERSION = 'markdown-logical-block-v4-table-json-v2-references' as const
export const TABLE_TRANSLATION_PROTOCOL = 'copilotix-table-translation-v2' as const
export const TABLE_TRANSLATION_CACHE_VERSION = 2 as const
export const MARKDOWN_MAPPING_ALGORITHM_VERSION = 1 as const

export type TranslationPlanUnitKind = 'plain' | 'table'

export interface TableTextSegment {
  id: string
  text: string
}

export interface TableCellPayload {
  id: string
  tag: 'td' | 'th'
  row: number
  column: number
  rowspan: number
  colspan: number
  segments: TableTextSegment[]
}

export interface TableAttachmentPayload {
  id: string
  sourceIndex: number
  segments: TableTextSegment[]
}

export interface TablePayload {
  id: string
  rows: TableCellPayload[][]
  captions: TableAttachmentPayload[]
  footnotes: TableAttachmentPayload[]
}

export interface TableTranslationRequest {
  protocol: typeof TABLE_TRANSLATION_PROTOCOL
  targetLanguage: 'zh-CN'
  tables: TablePayload[]
}

export interface TableTranslatedSegment {
  id: string
  text: string
}

export interface TableTranslationResponse {
  protocol: typeof TABLE_TRANSLATION_PROTOCOL
  translations: TableTranslatedSegment[]
}

export interface PlainTranslationRequest {
  protocol: 'copilotix-translation-plain-v1'
  targetLanguage: 'zh-CN'
  unitId: string
  sourceHash: string
  segments: TableTextSegment[]
}

export interface PlainTranslationResponse {
  protocol: 'copilotix-translation-plain-v1'
  unitId: string
  sourceHash: string
  translations: TableTranslatedSegment[]
}

export type TranslationPlanRequest = PlainTranslationRequest | TableTranslationRequest
export type TranslationPlanResponse = PlainTranslationResponse | TableTranslationResponse

export interface TranslationPlanResponseEnvelope {
  protocol: 'copilotix-translation-response-v1'
  unitId: string
  kind: TranslationPlanUnitKind
  sourceHash: string
  response: TranslationPlanResponse
}

export interface TranslationPlanWorkDescriptor {
  unitId: string
  kind: TranslationPlanUnitKind
  sourceHash: string
  blockIds: string[]
  requestPath: string
  responsePath: string
  resultPath: string
  status: 'pending' | 'completed' | 'failed'
}

export interface TranslationPlanCounts {
  total: number
  completed: number
  failed: number
}

export interface TranslationPlanOpenResult extends TranslationPlanCounts {
  planId: string
  taskId: string
  jobId: string
  sourceHash: string
  reused: boolean
}

export interface TranslationPlanListResult {
  items: TranslationPlanWorkDescriptor[]
  nextCursor: number | null
  counts: TranslationPlanCounts
}

export interface TranslationPlanMutationResult extends TranslationPlanCounts {
  unitId: string
  status: 'pending' | 'completed' | 'failed'
}

export interface TranslationPlanFinalizeResult extends TranslationPlanCounts {
  status: 'succeeded' | 'partial'
  failedBlockIdsSample: string[]
  translatedRelativePath: string
  manifestRelativePath: string
  checkpointRelativePath: string
  hashes: { translated: string; manifest: string; checkpoint: string }
}

const noNul = (value: string): boolean => !value.includes('\0')
const id = z.string().uuid().refine(noNul)
const hash = z.string().regex(/^[0-9a-f]{64}$/iu).refine(noNul)
const bounded = (max: number) => z.string().min(1).max(max).refine(noNul)
const relativePlanPath = bounded(1024).refine((value) =>
  value.startsWith('.translation/') && !value.startsWith('/') && !value.includes('\\') &&
  !value.split('/').some((part) => part === '..' || part.length === 0),
  'plan path must be a normalized relative .translation path'
)
// The durable plan may carry a large source text node. Provider-facing code
// remains responsible for splitting it into bounded request chunks.
const segmentSchema = z.object({ id: bounded(256), text: bounded(262_144) }).strict()
const tableCellSchema = z.object({
  id: bounded(256),
  tag: z.enum(['td', 'th']),
  row: z.number().int().min(0).max(10_000),
  column: z.number().int().min(0).max(10_000),
  rowspan: z.number().int().min(1).max(1_000),
  colspan: z.number().int().min(1).max(1_000),
  segments: z.array(segmentSchema).max(256)
}).strict()
const attachmentSchema = z.object({ id: bounded(256), sourceIndex: z.number().int().min(0).max(100_000), segments: z.array(segmentSchema).max(256) }).strict()
const tableSchema = z.object({
  id: bounded(256),
  rows: z.array(z.array(tableCellSchema).max(256)).max(1_000),
  captions: z.array(attachmentSchema).max(256),
  footnotes: z.array(attachmentSchema).max(256)
}).strict()

export const tableTranslationRequestSchema = z.object({
  protocol: z.literal(TABLE_TRANSLATION_PROTOCOL),
  targetLanguage: z.literal('zh-CN'),
  tables: z.array(tableSchema).max(32)
}).strict()

export const tableTranslationResponseSchema = z.object({
  protocol: z.literal(TABLE_TRANSLATION_PROTOCOL),
  translations: z.array(segmentSchema).max(10_000)
}).strict()

export const plainTranslationRequestSchema = z.object({
  protocol: z.literal('copilotix-translation-plain-v1'),
  targetLanguage: z.literal('zh-CN'),
  unitId: id,
  sourceHash: hash,
  segments: z.array(segmentSchema).max(256)
}).strict()

export const plainTranslationResponseSchema = z.object({
  protocol: z.literal('copilotix-translation-plain-v1'),
  unitId: id,
  sourceHash: hash,
  translations: z.array(segmentSchema).max(256)
}).strict()

export const translationPlanResponseEnvelopeSchema = z.discriminatedUnion('kind', [
  z.object({
    protocol: z.literal('copilotix-translation-response-v1'),
    unitId: id,
    kind: z.literal('plain'),
    sourceHash: hash,
    response: plainTranslationResponseSchema
  }).strict(),
  z.object({
    protocol: z.literal('copilotix-translation-response-v1'),
    unitId: id,
    kind: z.literal('table'),
    sourceHash: hash,
    response: tableTranslationResponseSchema
  }).strict()
]).superRefine((value, context) => {
  if (value.kind === 'plain' &&
    (value.response.unitId !== value.unitId || value.response.sourceHash !== value.sourceHash)) {
    context.addIssue({ code: 'custom', message: 'plain response identity must match its envelope' })
  }
})

export const translationPlanWorkDescriptorSchema = z.object({
  unitId: id,
  kind: z.enum(['plain', 'table']),
  sourceHash: hash,
  blockIds: z.array(bounded(256)).max(32),
  requestPath: relativePlanPath,
  responsePath: relativePlanPath,
  resultPath: relativePlanPath,
  status: z.enum(['pending', 'completed', 'failed'])
}).strict()

export const translationPlanCountsSchema = z.object({
  total: z.number().int().min(0).max(100_000),
  completed: z.number().int().min(0).max(100_000),
  failed: z.number().int().min(0).max(100_000)
}).strict()

export const translationPlanOpenResultSchema = translationPlanCountsSchema.extend({
  planId: id, taskId: id, jobId: id, sourceHash: hash, reused: z.boolean()
}).strict()
export const translationPlanListResultSchema = z.object({
  items: z.array(translationPlanWorkDescriptorSchema).max(32),
  nextCursor: z.number().int().min(0).nullable(),
  counts: translationPlanCountsSchema
}).strict()
export const translationPlanMutationResultSchema = translationPlanCountsSchema.extend({
  unitId: id, status: z.enum(['pending', 'completed', 'failed'])
}).strict()
export const translationPlanFinalizeResultSchema = translationPlanCountsSchema.extend({
  status: z.enum(['succeeded', 'partial']),
  failedBlockIdsSample: z.array(bounded(256)).max(64),
  translatedRelativePath: relativePlanPath.or(bounded(1024).refine((value) => !value.includes('\\') && !value.includes('..'))),
  manifestRelativePath: bounded(1024).refine((value) => !value.includes('\\') && !value.includes('..')),
  checkpointRelativePath: bounded(1024).refine((value) => !value.includes('\\') && !value.includes('..')),
  hashes: z.object({ translated: hash, manifest: hash, checkpoint: hash }).strict()
}).strict()

export function flattenSegments(request: TableTranslationRequest): TableTextSegment[] {
  return request.tables.flatMap((table) => [
    ...table.captions.flatMap((attachment) => attachment.segments),
    ...table.rows.flatMap((row) => row.flatMap((cell) => cell.segments)),
    ...table.footnotes.flatMap((attachment) => attachment.segments)
  ])
}

export function parseTableTranslationResponse(raw: string, request: TableTranslationRequest): TableTranslationResponse {
  const text = raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim()
  let parsed: unknown
  try { parsed = JSON.parse(text) as unknown } catch { throw new Error('表格翻译源返回的内容不是有效 JSON') }
  return validateTableTranslationResponse(parsed, request)
}

export function validateTableTranslationResponse(value: unknown, request: TableTranslationRequest): TableTranslationResponse {
  const parsed = tableTranslationResponseSchema.parse(value)
  const expectedIds = flattenSegments(request).map((segment) => segment.id)
  const expected = new Set(expectedIds)
  const actual = new Map<string, string>()
  for (const segment of parsed.translations) {
    if (!expected.has(segment.id)) throw new Error(`表格翻译响应包含未知 segment：${segment.id}`)
    if (actual.has(segment.id)) throw new Error(`表格翻译响应包含重复 segment：${segment.id}`)
    if (!segment.text.trim()) throw new Error(`表格翻译响应中的 segment 无有效译文：${segment.id}`)
    actual.set(segment.id, segment.text)
  }
  const missing = expectedIds.find((segmentId) => !actual.has(segmentId))
  if (missing) throw new Error(`表格翻译响应缺少 segment：${missing}`)
  if (parsed.translations.length !== expectedIds.length) throw new Error('表格翻译响应数量不匹配')
  return { protocol: TABLE_TRANSLATION_PROTOCOL, translations: expectedIds.map((segmentId) => ({ id: segmentId, text: actual.get(segmentId)! })) }
}

export function translationCacheKey(sourceHash: string, provider: TranslationProviderId, model: string, kind: TranslationPlanUnitKind): string {
  return `${TRANSLATION_PIPELINE_VERSION}:${TABLE_TRANSLATION_CACHE_VERSION}:${kind}:${sourceHash}:${provider}:${model}`
}
