import type { CoreUtilityOperationHandler } from '@platform/rpc/utility/coreUtilityRuntime'
import type { FigureInsightStore } from '@features/insight/utility'
import type { MarkdownEditStore } from '../../../utility/core/persistence/markdownEditStore'
import type { V2TaskRepositoryCompat } from '@features/library/utility'
import { paperChatFigureRequestSchema } from '../contract/paperChatFigures'
import { paperChatStatusRequestSchema, paperContextRequestSchema } from '../contract/paperChatSchemas'
import { paperChatDeleteTurnSchema, paperChatDocumentRequestSchema, paperChatLoadRequestSchema, paperChatSaveSessionSchema, paperChatSaveTurnSchema } from '../contract/paperChatStorageSchemas'
import { coreRagContentIndexPayloadSchema, type ChatOperations } from '../contract/rpc'
import { PaperChatFigureStore } from './paperChatFigureStore'
import { PaperChatStore } from './paperChatStore'
import { PaperContextBuilder } from './paperContextBuilder'
import type { RagContentIndexService } from './ragContentIndexService'
import type { SqliteRagRepository } from './sqliteRagRepository'

/** What chat reads from the rest of Utility; each getter throws while the database is not ready. */
export interface ChatOperationDeps {
  repository(): V2TaskRepositoryCompat
  ragRepository(): SqliteRagRepository
  ragIndex(): RagContentIndexService
  /** The reader's edit layer: chat context follows the user's edits and reading order. */
  edits: Pick<MarkdownEditStore, 'read' | 'readingOrder'>
  figureInsightStore(): FigureInsightStore
}

export function createChatOperations(deps: ChatOperationDeps) {
  const chatStore = new PaperChatStore((id) => deps.repository().getTask(id)?.outputDir ?? null)
  const handlers: Record<keyof ChatOperations, CoreUtilityOperationHandler> = {
    'chat:load': (request) => { const { documentId, before } = paperChatLoadRequestSchema.parse(request.payload); return chatStore.load(documentId, before) },
    'chat:save-turn': (request) => { const { documentId, turn } = paperChatSaveTurnSchema.parse(request.payload); return chatStore.saveTurn(documentId, turn) },
    'chat:session': (request) => chatStore.session(paperChatDocumentRequestSchema.parse(request.payload).documentId),
    'chat:save-session': (request) => { const { documentId, session } = paperChatSaveSessionSchema.parse(request.payload); return chatStore.saveSession(documentId, session) },
    'chat:delete-turn': (request) => chatStore.deleteTurn(paperChatDeleteTurnSchema.parse(request.payload)),
    'chat:clear': (request) => chatStore.clear(paperChatDocumentRequestSchema.parse(request.payload).documentId),
    'chat:ensure-index': (request, signal) => {
      signal.throwIfAborted()
      const { documentId } = paperChatStatusRequestSchema.parse(request.payload)
      deps.repository().ensureContentIndex(documentId)
      const rag = deps.ragRepository()
      const k = rag.getDocumentKnowledge(documentId) ?? rag.ensureDocumentKnowledge(documentId)
      return { state: k?.localState ?? 'unindexed', progress: k?.localProgress ?? 0, contentRevisionId: k?.activeContentRevisionId ?? null }
    },
    'chat:build-context': async (request, signal) => {
      const input = paperContextRequestSchema.parse(request.payload)
      // An unreadable edit layer falls back to the parsed text; saving an edit reports the problem.
      const edits = await deps.edits.read(input.documentId).catch(() => null)
      const order = edits?.order ? await deps.edits.readingOrder(input.documentId).catch(() => null) : null
      return new PaperContextBuilder(deps.ragRepository()).build(input, signal, edits, order)
    },
    'compute:paper-chat-figure': (request, signal) => new PaperChatFigureStore(deps.repository(), deps.figureInsightStore()).source(paperChatFigureRequestSchema.parse(request.payload), signal),
    'compute:rag-content-index': async (request, signal) => {
      const payload = coreRagContentIndexPayloadSchema.parse(request.payload)
      return deps.ragIndex().index(payload, signal)
    }
  }
  return { handlers }
}
