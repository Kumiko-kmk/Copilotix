/**
 * AI-generated structured reading of one paper, shown in the archive detail view.
 * Validated contract between the renderer and Main/Utility (see AGENTS.md §13). Only paper content goes in; no import metadata.
 */
import { z } from 'zod'
import { paperChatProviderSchema, PAPER_CHAT_MODELS, supportedChatModelSchema } from './paperChatSchemas'

const text = (max: number) => z.string().trim().min(1).max(max).refine((value) => ![...value].some((char) => char.charCodeAt(0) < 32 && !'\t\n\r'.includes(char)))
export const PAPER_INSIGHT_MAX_BYTES = 128 * 1024
export const paperInsightContentSchema = z.object({
  summary: text(1600), researchQuestion: text(2000), method: text(4000),
  contributions: z.array(text(1200)).max(12), findings: z.array(text(1200)).max(12),
  limitations: z.array(text(1200)).max(12), keywords: z.array(text(80)).max(20)
}).strict()
export const paperInsightSchema = paperInsightContentSchema.extend({
  model: z.object({ provider: paperChatProviderSchema, name: supportedChatModelSchema }).strict()
    .refine((model) => PAPER_CHAT_MODELS[model.provider].includes(model.name)),
  generatedAt: z.iso.datetime(), sourceRevision: text(512)
}).strict()
export type PaperInsight = z.infer<typeof paperInsightSchema>
export const paperInsightStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('missing') }).strict(),
  z.object({ status: z.literal('generating') }).strict(),
  z.object({ status: z.literal('ready'), insight: paperInsightSchema, stale: z.boolean() }).strict(),
  z.object({ status: z.literal('failed'), error: text(1024) }).strict(),
  z.object({ status: z.literal('unavailable'), reason: text(1024) }).strict()
])
export type PaperInsightState = z.infer<typeof paperInsightStateSchema>
export const paperInsightRequestSchema = z.object({ documentId: z.uuid() }).strict()
export const paperInsightChangedSchema = paperInsightRequestSchema.extend({ state: paperInsightStateSchema }).strict()
export const paperInsightRecordSchema = paperInsightRequestSchema.extend({ version: z.literal(1), insight: paperInsightSchema }).strict()
export const paperInsightSaveSchema = paperInsightRequestSchema.extend({ insight: paperInsightSchema }).strict()
export const paperInsightSavedSchema = z.object({ saved: z.literal(true) }).strict()
export const paperInsightCancelSchema = z.object({ cancelled: z.boolean() }).strict()
export const paperInsightContextRequestSchema = paperInsightRequestSchema.extend({ budgetBytes: z.number().int().min(2048).max(8192) }).strict()
export const paperInsightContextSchema = z.object({
  documentId: z.uuid(), sourceRevision: text(512), language: z.enum(['original', 'translated']),
  excerpts: z.array(z.object({ section: text(200), text: text(8192) }).strict()).min(1).max(32),
  truncated: z.boolean()
}).strict()
export type PaperInsightContext = z.infer<typeof paperInsightContextSchema>

/** What the archive page needs; App wires it to IPC once the pipeline exists. */
export interface PaperInsightSource {
  get(documentId: string): Promise<PaperInsightState>
  generate(documentId: string): Promise<void>
  cancel?(documentId: string): Promise<unknown>
  /** Push updates while generating; returns an unsubscribe function. */
  subscribe(listener: (documentId: string, state: PaperInsightState) => void): () => void
}
