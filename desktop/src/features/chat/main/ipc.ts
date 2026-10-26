import type { PaperChatStatus } from '../contract/paperChatSchemas'
import { emitEvent, type IpcRegistrar } from '@platform/ipc/main/ipc'
import { paperChatChannels } from '../contract/ipc'
import type { PaperChatService } from './paperChatService'

export function registerPaperChatHandlers(service: PaperChatService, ensureIndex: (documentId: string) => Promise<PaperChatStatus>, ipc: IpcRegistrar): void {
  ipc.handle(paperChatChannels.load, (_event, request) => service.load(request))
  ipc.handle(paperChatChannels.session, (_event, request) => service.session(request.documentId))
  ipc.handle(paperChatChannels.saveSession, (_event, request) => service.saveSession(request.documentId, request.session))
  ipc.handle(paperChatChannels.deleteTurn, (_event, request) => service.deleteTurn(request))
  ipc.handle(paperChatChannels.clear, (_event, request) => service.clear(request.documentId))
  ipc.handle(paperChatChannels.ask, (event, request) => service.ask(request, (value) => emitEvent(event.sender, paperChatChannels.event, value)))
  ipc.handle(paperChatChannels.cancel, (_event, request) => service.cancel(request.requestId))
  ipc.handle(paperChatChannels.ensureIndex, (_event, request) => ensureIndex(request.documentId))
}
