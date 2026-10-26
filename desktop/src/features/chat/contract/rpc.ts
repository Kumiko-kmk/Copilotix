import { z } from 'zod'
import { coreIdSchema } from '@platform/rpc/contract/protocol'
import { paperChatFigureRequestSchema, paperChatFigureSourceSchema } from './paperChatFigures'
import { paperChatStatusRequestSchema, paperChatStatusSchema, paperContextRequestSchema, paperContextResultSchema } from './paperChatSchemas'
import { paperChatClearedSchema, paperChatDeleteTurnSchema, paperChatDeletedSchema, paperChatDocumentRequestSchema, paperChatLoadRequestSchema, paperChatPageSchema, paperChatSaveSessionSchema, paperChatSavedSchema, paperChatSaveTurnSchema, paperChatSessionSchema } from './paperChatStorageSchemas'

export const coreRagContentIndexPayloadSchema = z.object({
  documentId: coreIdSchema,
  contentRevisionId: coreIdSchema
}).strict()
export const coreRagContentIndexResultSchema = z.object({
  documentId: coreIdSchema,
  contentRevisionId: coreIdSchema,
  chunkCount: z.number().int().min(0).max(100_000),
  revisionState: z.literal('ready')
}).strict()

/**
 * Core RPC operations of paper chat: the per-document chat files, the retrieval
 * index (`rag-content-index` job) and the context built from it. Names are kept
 * from the original registry; the rag_* tables they use stay in schema 4.
 */
export const chatOperations = {
  'chat:load': { payload: paperChatLoadRequestSchema, result: paperChatPageSchema },
  'chat:save-turn': { payload: paperChatSaveTurnSchema, result: paperChatSavedSchema },
  'chat:session': { payload: paperChatDocumentRequestSchema, result: paperChatSessionSchema },
  'chat:save-session': { payload: paperChatSaveSessionSchema, result: paperChatSavedSchema },
  'chat:delete-turn': { payload: paperChatDeleteTurnSchema, result: paperChatDeletedSchema },
  'chat:clear': { payload: paperChatDocumentRequestSchema, result: paperChatClearedSchema },
  'chat:ensure-index': { payload: paperChatStatusRequestSchema, result: paperChatStatusSchema },
  'chat:build-context': { payload: paperContextRequestSchema, result: paperContextResultSchema },
  'compute:paper-chat-figure': { payload: paperChatFigureRequestSchema, result: paperChatFigureSourceSchema },
  'compute:rag-content-index': { payload: coreRagContentIndexPayloadSchema, result: coreRagContentIndexResultSchema }
} as const
export type ChatOperations = typeof chatOperations
