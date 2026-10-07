import { z } from 'zod'
import { citationLocatorSchema, ragQuerySchema, ragUuidSchema, ragWireByteLength, selectionFragmentSchema, scoreProvenanceSchema } from './ragSchemas'
import type { AppSettings } from './types'

export const CHAT_CONSENT_VERSION = 2
export const PAPER_CHAT_DEFAULT_BUDGET = 48_000
export const PAPER_CHAT_MAX_BYTES = 256 * 1024
export const paperChatProviderSchema = z.enum(['qwen', 'deepseek'])
export type PaperChatProvider = z.infer<typeof paperChatProviderSchema>
export const chatModelSchema = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9_.:/-]+$/u)
export const contentIdentitySchema = citationLocatorSchema.shape.contentRevisionId
// Follow the existing translation configuration; the legacy chatProvider is ignored.
export function resolvePaperChatProvider(settings: Pick<AppSettings, 'translationProvider' | 'enabledTranslationProviders'>, selected?: PaperChatProvider): PaperChatProvider | null {
  const provider = selected ?? settings.translationProvider
  return (provider === 'qwen' || provider === 'deepseek') && settings.enabledTranslationProviders.includes(provider) ? provider : null
}
export function hasPaperChatConsent(settings: Pick<AppSettings, 'chatConsentVersion' | 'chatConsentProvider' | 'translationProvider' | 'enabledTranslationProviders'>, provider: PaperChatProvider): boolean {
  return settings.chatConsentVersion === CHAT_CONSENT_VERSION && (settings.chatConsentProvider ?? resolvePaperChatProvider(settings)) === provider
}
export const PAPER_CHAT_MODELS: Record<PaperChatProvider, readonly string[]> = {
  qwen: ['qwen-plus', 'qwen3.8-flash', 'qwen3.8-max'],
  deepseek: ['deepseek-flash', 'deepseek-v4-pro']
}
const content = (max: number) => z.string().min(1).max(max).refine((s) => !Array.from(s).some((c) => { const n = c.codePointAt(0)!; return (n < 32 && n !== 9 && n !== 10 && n !== 13) || (n >= 127 && n <= 159) }))
export const paperChatPinnedSchema = z.object({
  view: z.enum(['original', 'translated']),
  text: content(16_384),
  fragments: z.array(selectionFragmentSchema).min(1).max(64),
  contentRevisionId: contentIdentitySchema
}).strict()
export const paperChatHistorySchema = z.array(z.object({ role: z.enum(['user', 'assistant']), content: content(8_192) }).strict()).max(12)
  .refine((items) => items.reduce((n, item) => n + item.content.length, 0) <= 24_000, 'History exceeds budget')
export const paperChatAskRequestSchema = z.object({
  documentId: ragUuidSchema,
  question: ragQuerySchema,
  pinned: z.array(paperChatPinnedSchema).max(8),
  history: paperChatHistorySchema,
  model: chatModelSchema.optional(),
  provider: paperChatProviderSchema.optional()
}).strict().refine((value) => ragWireByteLength(value) <= PAPER_CHAT_MAX_BYTES, 'Request exceeds byte budget')
export const paperChatAskResultSchema = z.object({ requestId: ragUuidSchema }).strict()
export const paperChatCancelRequestSchema = paperChatAskResultSchema
export const paperChatCancelResultSchema = z.object({ cancelled: z.boolean() }).strict()
export const paperChatStatusRequestSchema = z.object({ documentId: ragUuidSchema }).strict()
export const paperChatStatusSchema = z.object({
  state: z.enum(['unindexed', 'queued', 'indexing', 'ready', 'stale', 'failed']),
  progress: z.number().int().min(0).max(100),
  contentRevisionId: contentIdentitySchema.nullable()
}).strict()
export const paperContextRequestSchema = z.object({
  documentId: paperChatAskRequestSchema.shape.documentId,
  question: paperChatAskRequestSchema.shape.question,
  pinned: paperChatAskRequestSchema.shape.pinned,
  budgetChars: z.number().int().min(1_024).max(96_000).default(PAPER_CHAT_DEFAULT_BUDGET)
}).strict().refine((value) => ragWireByteLength(value) <= PAPER_CHAT_MAX_BYTES, 'Request exceeds byte budget')
export const paperEvidenceSchema = z.object({
  evidenceId: z.string().regex(/^E[1-9]\d{0,3}$/u),
  chunkId: z.string().min(1).max(256),
  locator: citationLocatorSchema,
  sectionPath: z.array(z.string().max(512)).max(16),
  text: content(96_000),
  translatedSelections: z.array(content(16_384)).max(8),
  mappingConfidence: z.enum(['source', 'translated']),
  scoreProvenance: z.array(scoreProvenanceSchema).min(1).max(8)
}).strict()
export const paperContextResultSchema = z.object({
  documentId: ragUuidSchema,
  contentRevisionId: contentIdentitySchema,
  evidence: z.array(paperEvidenceSchema).max(9_999),
  outline: z.array(z.string().max(512)).max(128),
  truncated: z.boolean()
}).strict().superRefine((value, ctx) => {
  if (ragWireByteLength(value) > PAPER_CHAT_MAX_BYTES) ctx.addIssue({ code: 'custom', message: 'Evidence exceeds byte budget' })
  const ids = new Set<string>()
  for (const e of value.evidence) {
    if (ids.has(e.evidenceId) || e.locator.documentId !== value.documentId || e.locator.contentRevisionId !== value.contentRevisionId) ctx.addIssue({ code: 'custom', message: 'Evidence identity mismatch' })
    ids.add(e.evidenceId)
  }
})
export type PaperChatAskRequest = z.infer<typeof paperChatAskRequestSchema>
export type PaperChatPinned = z.infer<typeof paperChatPinnedSchema>
export type PaperContextRequest = z.infer<typeof paperContextRequestSchema>
export type PaperContext = z.infer<typeof paperContextResultSchema>
export type PaperEvidence = z.infer<typeof paperEvidenceSchema>
export type PaperChatStatus = z.infer<typeof paperChatStatusSchema>
