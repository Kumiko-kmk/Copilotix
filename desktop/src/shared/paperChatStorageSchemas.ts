import { z } from 'zod'
import { citationSchema, ragUuidSchema, ragWireByteLength } from './ragSchemas'
import { chatModelSchema, paperChatPinnedSchema, paperChatProviderSchema, PAPER_CHAT_MAX_BYTES } from './paperChatSchemas'

// File format lives beside each paper; no database migration or credentials.
export const paperChatTurnSchema = z.object({
  id: ragUuidSchema,
  createdAt: z.string().datetime(),
  provider: paperChatProviderSchema,
  model: chatModelSchema,
  question: z.string().min(1).max(2_000),
  answer: z.string().max(32_768),
  citations: z.record(z.string().regex(/^E[1-9]\d{0,3}$/u), citationSchema).refine((items) => Object.keys(items).length <= 50),
  status: z.enum(['pending', 'completed', 'failed', 'cancelled'])
}).strict().refine((value) => ragWireByteLength(value) <= PAPER_CHAT_MAX_BYTES - 1024, 'Turn exceeds byte budget')
export const paperChatSessionSchema = z.object({
  draft: z.string().max(2_000),
  pinned: z.array(paperChatPinnedSchema).max(8),
  selectedModel: z.object({ provider: paperChatProviderSchema, model: z.string().max(128), custom: z.boolean() }).strict().nullable()
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
export const paperChatClearedSchema = z.object({ cleared: z.literal(true) }).strict()
export type StoredPaperChatTurn = z.infer<typeof paperChatTurnSchema>
export type PaperChatSession = z.infer<typeof paperChatSessionSchema>
export type PaperChatPage = z.infer<typeof paperChatPageSchema>
export type PaperChatLoadRequest = z.infer<typeof paperChatLoadRequestSchema>
