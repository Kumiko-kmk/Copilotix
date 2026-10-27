import { z } from 'zod'
import { paperChatProviderSchema } from '@features/chat/contract/paperChatSchemas'

export const FIGURE_INSIGHT_PROMPT_VERSION = 'figure-v1.2026-10-11.2'
export const FIGURE_INSIGHT_MAX_IMAGE_BYTES = 14 * 1024 * 1024
export const FIGURE_INSIGHT_MAX_REQUEST_BYTES = 20 * 1024 * 1024
export const figureInsightRequestSchema = z.object({
  documentId: z.string().uuid(), figureId: z.string().min(1).max(256)
}).strict()
export type FigureInsightRequest = z.infer<typeof figureInsightRequestSchema>

export const archiveCoverSourceRequestSchema = z.object({ documentId: z.uuid() }).strict()
export const archiveCoverSourceSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  hasManifest: z.boolean(),
  figures: z.array(z.object({
    figureId: z.string().min(1).max(256),
    imagePath: z.string().regex(/^images\/figures\/figure-p\d+-[a-f0-9]{24}\.png$/u),
    width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
    pageIndex: z.number().int().nonnegative(),
    cropBox: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
    displayWeight: z.number().int().min(0).max(100).optional()
  }).strict()).max(2000)
}).strict()
export type ArchiveCoverSource = z.infer<typeof archiveCoverSourceSchema>

/** The entire model output contract. Location and provenance are application-owned. */
export const figureInsightContentSchema = z.object({
  displayWeight: z.number().int().min(0).max(100),
  overview: z.string().trim().max(240),
  takeaway: z.string().trim().max(160)
}).strict().refine(v => v.displayWeight === 0 || Boolean(v.overview && v.takeaway), '非零评分需要概述和要点')

export const figureInsightModelSchema = z.union([
  z.object({ provider: z.literal('qwen'), name: z.enum(['qwen3.8-flash', 'qwen3.8-max']) }).strict(),
  z.object({ provider: z.literal('deepseek'), name: z.literal('deepseek-flash') }).strict(),
  z.object({ provider: z.literal('codex'), name: z.string().min(1).max(128) }).strict()
])
export const figureInsightLocationSchema = z.object({
  figureId: z.string().min(1).max(256),
  imagePath: z.string().regex(/^images\/figures\/figure-p\d+-[a-f0-9]{24}\.png$/u),
  sourceRevision: z.string().min(1).max(256),
  pageIndex: z.number().int().nonnegative(),
  cropBox: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
  mappingIds: z.array(z.string().max(256)).max(2048),
  sourceAssets: z.array(z.string().max(2048)).max(2048),
  width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
  pngSha256: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict()
export const figureInsightUploadSchema = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg']), byteLength: z.number().int().positive().max(FIGURE_INSIGHT_MAX_IMAGE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u), jpegQuality: z.literal(98).optional()
}).strict()
export const figureInsightRecordSchema = z.object({
  version: z.literal(1), documentId: z.string().uuid(),
  figure: figureInsightLocationSchema,
  content: figureInsightContentSchema,
  provenance: z.object({ sourceRevision: z.string().length(64), promptVersion: z.string().max(128),
    model: figureInsightModelSchema, generatedAt: z.string().datetime(), upload: figureInsightUploadSchema.optional() }).strict()
}).strict()
export type FigureInsightRecord = z.infer<typeof figureInsightRecordSchema>
export const figureInsightStateSchema = z.union([
  z.object({ status: z.literal('missing') }).strict(),
  z.object({ status: z.literal('generating') }).strict(),
  z.object({ status: z.literal('ready'), record: figureInsightRecordSchema, stale: z.boolean() }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.string().max(512) }).strict(),
  z.object({ status: z.literal('failed'), error: z.string().max(512) }).strict()
])
export type FigureInsightState = z.infer<typeof figureInsightStateSchema>
export const figureInsightChangedSchema = figureInsightRequestSchema.extend({ state: figureInsightStateSchema }).strict()
export const figureInsightCancelSchema = z.object({ cancelled: z.boolean() }).strict()
export const figureInsightDescriptorSchema = figureInsightRequestSchema.extend({
  figure: figureInsightLocationSchema,
  sourceRevision: z.string().length(64),
  imagePath: z.string().min(1).max(8192), imageBytes: z.number().int().positive().max(FIGURE_INSIGHT_MAX_IMAGE_BYTES),
  context: z.object({ title: z.string().nullable(), caption: z.string().max(8000),
    related: z.array(z.string().max(4000)).max(12),
    paperOverview: z.array(z.string().max(4000)).max(24) }).strict()
}).strict()
export type FigureInsightDescriptor = z.infer<typeof figureInsightDescriptorSchema>
export const figureInsightSaveSchema = figureInsightRequestSchema.extend({ sourceRevision: z.string().length(64),
  content: figureInsightContentSchema, model: figureInsightModelSchema, upload: figureInsightUploadSchema.optional() }).strict()
export type FigureInsightSave = z.infer<typeof figureInsightSaveSchema>

export function resolveFigureInsightModel(provider: z.infer<typeof paperChatProviderSchema>, selected: string): string {
  if (provider === 'codex') return selected
  return provider === 'deepseek' ? 'deepseek-flash' : selected === 'qwen3.8-max' ? selected : 'qwen3.8-flash'
}
