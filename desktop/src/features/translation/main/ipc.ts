import type { IpcRegistrar } from '@platform/ipc/main/ipc'
import type { TaskService } from '@features/library/main'
import { translationChannels } from '../contract/ipc'

export function registerTranslationIpc(ipc: IpcRegistrar, tasks: Pick<TaskService, 'retranslateEdited'>): void {
  ipc.handle(translationChannels.retranslateEdited, (_event, documentId) => tasks.retranslateEdited(documentId))
}
