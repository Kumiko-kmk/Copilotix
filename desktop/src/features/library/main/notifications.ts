import { Notification } from 'electron'
import type { TaskRepositoryCompat } from '../contract/taskRepository'
import type { TaskService } from './taskService'

/** A system notification when a document finishes; clicking it opens that document. */
export function registerTaskNotifications(tasks: TaskService, repository: Pick<TaskRepositoryCompat, 'getTask'>, actions: {
  showWindow(): void
  openDocument(documentId: string): void
}): void {
  tasks.on('notification', async (taskId: string, status: 'completed' | 'partial' | 'failed') => {
    const task = await repository.getTask(taskId)
    if (!task || !Notification.isSupported()) return
    const notification = new Notification({
      title: status === 'failed' ? 'Copilotix 任務失敗' : status === 'partial' ? 'Copilotix 部分翻譯完成' : 'Copilotix 任務完成',
      body: task.name
    })
    notification.on('click', () => {
      actions.showWindow()
      actions.openDocument(taskId)
    })
    notification.show()
  })
}
