import type { IpcRegistrar } from '@platform/ipc/main/ipc'
import { figureInsightChannels, paperInsightChannels } from '../contract/ipc'
import type { FigureInsightService } from './figureInsightService'
import type { PaperInsightService } from './paperInsightService'

export function registerPaperInsightHandlers(service: PaperInsightService, ipc: IpcRegistrar): void {
  ipc.handle(paperInsightChannels.get, (_event, request) => request.savedOnly ? service.getSaved(request.documentId) : service.get(request.documentId))
  ipc.handle(paperInsightChannels.list, (_event, request) => service.list(request.documentIds))
  ipc.handle(paperInsightChannels.generate, (_event, request) => service.generate(request.documentId))
  ipc.handle(paperInsightChannels.cancel, (_event, request) => service.cancel(request.documentId))
}

export function registerFigureInsightHandlers(service: FigureInsightService, ipc: IpcRegistrar): void {
  ipc.handle(figureInsightChannels.get, (_event, request) => service.get(request))
  ipc.handle(figureInsightChannels.coverSource, (_event, request) => service.coverSource(request.documentId))
  ipc.handle(figureInsightChannels.generate, (_event, request) => service.generate(request))
  ipc.handle(figureInsightChannels.cancel, (_event, request) => service.cancel(request))
}
