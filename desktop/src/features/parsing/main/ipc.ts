import type { IpcRegistrar } from '@platform/ipc/main/ipc'
import type { TaskService } from '@main/taskService'
import { parsingChannels } from '../contract/ipc'

export function registerParsingIpc(ipc: IpcRegistrar, tasks: Pick<TaskService, 'cacheFigure' | 'repairTextLayer'>): void {
  ipc.handle(parsingChannels.cacheFigure, (_event, request) => tasks.cacheFigure(request))
  ipc.handle(parsingChannels.repairTextLayer, (_event, documentId) => tasks.repairTextLayer(documentId))
}
