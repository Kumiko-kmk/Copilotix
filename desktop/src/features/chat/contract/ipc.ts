import { eventChannel, invokeChannel, type IpcBridge } from '@platform/ipc/contract/channels'
import { paperChatAskRequestSchema, paperChatAskResultSchema, paperChatCancelRequestSchema, paperChatCancelResultSchema, paperChatStatusRequestSchema, paperChatStatusSchema, type PaperChatAskRequest, type PaperChatStatus } from '@shared/paperChatSchemas'
import { paperChatClearedSchema, paperChatDeleteTurnSchema, paperChatDeletedSchema, paperChatDocumentRequestSchema, paperChatLoadRequestSchema, paperChatPageSchema, paperChatSaveSessionSchema, paperChatSavedSchema, paperChatSessionSchema, type PaperChatLoadRequest, type PaperChatPage, type PaperChatSession } from '@shared/paperChatStorageSchemas'
import { ragStreamEventSchema, type RagStreamEvent } from '@shared/ragSchemas'

export const paperChatChannels = {
  load: invokeChannel('paper-chat:load', paperChatLoadRequestSchema, paperChatPageSchema),
  session: invokeChannel('paper-chat:session', paperChatDocumentRequestSchema, paperChatSessionSchema),
  saveSession: invokeChannel('paper-chat:save-session', paperChatSaveSessionSchema, paperChatSavedSchema),
  deleteTurn: invokeChannel('paper-chat:delete-turn', paperChatDeleteTurnSchema, paperChatDeletedSchema),
  clear: invokeChannel('paper-chat:clear', paperChatDocumentRequestSchema, paperChatClearedSchema),
  ask: invokeChannel('paper-chat:ask', paperChatAskRequestSchema, paperChatAskResultSchema),
  cancel: invokeChannel('paper-chat:cancel', paperChatCancelRequestSchema, paperChatCancelResultSchema),
  ensureIndex: invokeChannel('paper-chat:ensure-index', paperChatStatusRequestSchema, paperChatStatusSchema),
  /** Streamed answer events of `ask`, sent to the asking renderer only. */
  event: eventChannel('paper-chat:event', ragStreamEventSchema)
}

export interface PaperChatDesktopApi {
  load(request: PaperChatLoadRequest): Promise<PaperChatPage>
  session(request: { documentId: string }): Promise<PaperChatSession>
  saveSession(request: { documentId: string; session: PaperChatSession }): Promise<{ saved: true }>
  deleteTurn(request: { documentId: string; turnId: string; createdAt: string }): Promise<{ deleted: true }>
  clear(request: { documentId: string }): Promise<{ cleared: true }>
  ask(request: PaperChatAskRequest): Promise<{ requestId: string; createdAt?: string }>
  cancel(request: { requestId: string }): Promise<{ cancelled: boolean }>
  ensureIndex(request: { documentId: string }): Promise<PaperChatStatus>
  onEvent(listener: (event: RagStreamEvent) => void): () => void
}

export function createPaperChatApi(ipc: IpcBridge): PaperChatDesktopApi {
  return {
    load: request => ipc.invoke(paperChatChannels.load, request),
    session: request => ipc.invoke(paperChatChannels.session, request),
    saveSession: request => ipc.invoke(paperChatChannels.saveSession, request),
    deleteTurn: request => ipc.invoke(paperChatChannels.deleteTurn, request),
    clear: request => ipc.invoke(paperChatChannels.clear, request),
    ask: request => ipc.invoke(paperChatChannels.ask, request),
    cancel: request => ipc.invoke(paperChatChannels.cancel, request),
    ensureIndex: request => ipc.invoke(paperChatChannels.ensureIndex, request),
    onEvent: listener => ipc.subscribe(paperChatChannels.event, listener)
  }
}
