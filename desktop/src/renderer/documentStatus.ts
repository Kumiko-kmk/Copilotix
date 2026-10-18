import type { DocumentSummary } from '@shared/ipcSchemas'

export type WorkflowStatus = DocumentSummary['workflow']['status']

export const statusLabels: Record<WorkflowStatus, string> = {
  queued: '排队中', uploading: '上传中', parsing: '解析中', translating: '翻译中',
  partial: '部分完成', completed: '已完成', failed: '失败'
}

export const ACTIVE_STATUSES: ReadonlySet<WorkflowStatus> = new Set<WorkflowStatus>(['queued', 'uploading', 'parsing', 'translating'])

/** Failed and partial papers can be queued again; a translating one can be restarted. Completed translations are kept. */
export function canRetry(status: WorkflowStatus): boolean {
  return status === 'failed' || status === 'partial' || status === 'translating'
}
