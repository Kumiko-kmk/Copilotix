import { paperChatAskRequestSchema, paperChatAskResultSchema, paperChatCancelRequestSchema, paperChatCancelResultSchema, paperChatStatusRequestSchema, paperChatStatusSchema, type PaperChatStatus } from '@shared/paperChatSchemas'
import { ragStreamEventSchema } from '@shared/ragSchemas'
import { paperChatDocumentRequestSchema, paperChatLoadRequestSchema, paperChatPageSchema, paperChatSaveSessionSchema, paperChatSessionSchema, paperChatSavedSchema, paperChatClearedSchema } from '@shared/paperChatStorageSchemas'
import { registerValidatedHandler, sendValidatedEvent, type IpcValidationOptions } from '../ipc'
import type { PaperChatService } from './paperChatService'

export function registerPaperChatHandlers(service: PaperChatService, ensureIndex: (documentId: string) => Promise<PaperChatStatus>, options: IpcValidationOptions): void {
  registerValidatedHandler('paper-chat:load', paperChatLoadRequestSchema, paperChatPageSchema, (_event, request) => service.load(request), options)
  registerValidatedHandler('paper-chat:session', paperChatDocumentRequestSchema, paperChatSessionSchema, (_event, request) => service.session(request.documentId), options)
  registerValidatedHandler('paper-chat:save-session', paperChatSaveSessionSchema, paperChatSavedSchema, (_event, request) => service.saveSession(request.documentId, request.session), options)
  registerValidatedHandler('paper-chat:clear', paperChatDocumentRequestSchema, paperChatClearedSchema, (_event, request) => service.clear(request.documentId), options)
  registerValidatedHandler('paper-chat:ask', paperChatAskRequestSchema, paperChatAskResultSchema,
    (event, request) => service.ask(request, (value) => sendValidatedEvent(event.sender, 'paper-chat:event', ragStreamEventSchema, value)), options)
  registerValidatedHandler('paper-chat:cancel', paperChatCancelRequestSchema, paperChatCancelResultSchema,
    (_event, request) => service.cancel(request.requestId), options)
  registerValidatedHandler('paper-chat:ensure-index', paperChatStatusRequestSchema, paperChatStatusSchema,
    (_event, request) => ensureIndex(request.documentId), options)
}
