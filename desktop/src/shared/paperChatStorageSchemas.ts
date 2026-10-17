import { z } from 'zod'
import { chatUsageSchema } from './chatResultMetadata'
import { citationSchema, ragUuidSchema, ragWireByteLength } from './ragSchemas'
import { chatModelSchema, paperChatPinnedSchema, paperChatProviderSchema, resolvePaperChatModel, PAPER_CHAT_MAX_BYTES } from './paperChatSchemas'

/** What the question was asked about, kept with the turn for display (text is shortened). */
export const PAPER_CHAT_SELECTION_PREVIEW = 600
export const paperChatTurnSelectionSchema = z.object({
  view: paperChatPinnedSchema.shape.view,
  text: z.string().min(1).max(PAPER_CHAT_SELECTION_PREVIEW),
  pageIndex: z.number().int().min(0).optional()
}).strict()
export type PaperChatTurnSelection = z.infer<typeof paperChatTurnSelectionSchema>
export function paperChatTurnSelections(pinned: readonly z.infer<typeof paperChatPinnedSchema>[]): PaperChatTurnSelection[] {
  return pinned.map((pin) => {
    const pageIndex = pin.fragments[0]?.pageIndex
    let text = pin.text
    if (text.length > PAPER_CHAT_SELECTION_PREVIEW) {
      text = text.slice(0, PAPER_CHAT_SELECTION_PREVIEW - 1)
      if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1)
      text += '…'
    }
    return { view: pin.view, text, ...(typeof pageIndex === 'number' ? { pageIndex } : {}) }
  })
}

// File format lives beside each paper; no database migration or credentials.
export const paperChatTurnSchema = z.object({
  id: ragUuidSchema,
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  usage: chatUsageSchema.nullable().optional(),
  provider: paperChatProviderSchema,
  model: chatModelSchema,
  question: z.string().min(1).max(2_000),
  // Added with turn selections; files without it stay valid.
  selections: z.array(paperChatTurnSelectionSchema).max(8).optional(),
  answer: z.string().max(32_768),
  citations: z.record(z.string().regex(/^E[1-9]\d{0,3}$/u), citationSchema).refine((items) => Object.keys(items).length <= 50),
  status: z.enum(['pending', 'completed', 'failed', 'cancelled'])
}).strict().refine((value) => ragWireByteLength(value) <= PAPER_CHAT_MAX_BYTES - 1024, 'Turn exceeds byte budget')
export const paperChatSessionSchema = z.object({
  draft: z.string().max(2_000),
  pinned: z.array(paperChatPinnedSchema).max(8),
  selectedModel: z.object({ provider: paperChatProviderSchema, model: z.string().max(128), custom: z.boolean().optional() }).strict()
    .transform(({ provider, model }) => ({ provider, model: resolvePaperChatModel(provider, model) })).nullable()
}).strict().refine((value) => ragWireByteLength(value) <= PAPER_CHAT_MAX_BYTES - 1024, 'Session exceeds byte budget')
export const emptyPaperChatSession = (): PaperChatSession => ({ draft: '', pinned: [], selectedModel: null })
export const paperChatDocumentRequestSchema = z.object({ documentId: ragUuidSchema }).strict()
export const paperChatCursorSchema = z.string().regex(/^\d{13}-[0-9a-f-]{36}\.json$/u)
export const paperChatLoadRequestSchema = paperChatDocumentRequestSchema.extend({ before: paperChatCursorSchema.optional() }).strict()
export const paperChatPageSchema = z.object({
  turns: z.array(paperChatTurnSchema).max(20),
  next: paperChatCursorSchema.nullable()
}).strict().refine((value) => ragWireByteLength(value) <= PAPER_CHAT_MAX_BYTES)
export const paperChatSaveTurnSchema = paperChatDocumentRequestSchema.extend({ turn: paperChatTurnSchema }).strict()
export const paperChatSaveSessionSchema = paperChatDocumentRequestSchema.extend({ session: paperChatSessionSchema }).strict()
export const paperChatSavedSchema = z.object({ saved: z.literal(true) }).strict()
export const paperChatDeleteTurnSchema = paperChatDocumentRequestSchema.extend({ turnId: ragUuidSchema, createdAt: z.string().datetime() }).strict()
export const paperChatDeletedSchema = z.object({ deleted: z.literal(true) }).strict()
export type PaperChatDeleteTurnRequest = z.infer<typeof paperChatDeleteTurnSchema>
export const paperChatClearedSchema = z.object({ cleared: z.literal(true) }).strict()
export type StoredPaperChatTurn = z.infer<typeof paperChatTurnSchema>
export type PaperChatSession = z.infer<typeof paperChatSessionSchema>
export type PaperChatPage = z.infer<typeof paperChatPageSchema>
export type PaperChatLoadRequest = z.infer<typeof paperChatLoadRequestSchema>
