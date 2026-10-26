import type { IpcRegistrar } from '@platform/ipc/main/ipc'
import type { TaskService } from '@features/library/main'
import { parsingChannels } from '../contract/ipc'

export function registerParsingIpc(ipc: IpcRegistrar, tasks: Pick<TaskService, 'repairTextLayer'>): void {
  ipc.handle(parsingChannels.repairTextLayer, (_event, documentId) => tasks.repairTextLayer(documentId))
}
