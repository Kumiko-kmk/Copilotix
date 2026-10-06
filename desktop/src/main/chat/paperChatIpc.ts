import { paperChatAskRequestSchema, paperChatAskResultSchema, paperChatCancelRequestSchema, paperChatCancelResultSchema, paperChatStatusRequestSchema, paperChatStatusSchema, type PaperChatStatus } from '@shared/paperChatSchemas'
import { ragStreamEventSchema } from '@shared/ragSchemas'
import { registerValidatedHandler, sendValidatedEvent, type IpcValidationOptions } from '../ipc'
import type { PaperChatService } from './paperChatService'

export function registerPaperChatHandlers(service: PaperChatService, ensureIndex: (documentId: string) => Promise<PaperChatStatus>, options: IpcValidationOptions): void {
  registerValidatedHandler('paper-chat:ask', paperChatAskRequestSchema, paperChatAskResultSchema,
    (event, request) => service.ask(request, (value) => sendValidatedEvent(event.sender, 'paper-chat:event', ragStreamEventSchema, value)), options)
  registerValidatedHandler('paper-chat:cancel', paperChatCancelRequestSchema, paperChatCancelResultSchema,
    (_event, request) => service.cancel(request.requestId), options)
  registerValidatedHandler('paper-chat:ensure-index', paperChatStatusRequestSchema, paperChatStatusSchema,
    (_event, request) => ensureIndex(request.documentId), options)
}
