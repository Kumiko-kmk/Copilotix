import type { DocumentSummary } from '../contract/documentSchemas'

export type WorkflowStatus = DocumentSummary['workflow']['status']
type Workflow = DocumentSummary['workflow']

// `queued` is the gap after parsing: the original is ready and translation has not started.
export const statusLabels: Record<WorkflowStatus, string> = {
  queued: '等待翻譯', uploading: '上傳中', parsing: '解析中', translating: '翻譯中',
  partial: '部分完成', completed: '已完成', failed: '失敗'
}

export const ACTIVE_STATUSES: ReadonlySet<WorkflowStatus> = new Set<WorkflowStatus>(['queued', 'uploading', 'parsing', 'translating'])

/** Failed and partial papers can be queued again; a translating one can be restarted. Completed translations are kept. */
export function canRetry(status: WorkflowStatus): boolean {
  return status === 'failed' || status === 'partial' || status === 'translating'
}

/** The original Markdown exists once parsing has finished, whatever happened to translation. */
export function originalAvailable(workflow: Workflow): boolean {
  return workflow.status === 'queued' || workflow.status === 'translating' || workflow.status === 'partial' ||
    workflow.status === 'completed' || (workflow.status === 'failed' && workflow.translationProgress !== undefined)
}

export type WorkflowStepState = 'done' | 'active' | 'waiting' | 'failed' | 'partial'
export interface WorkflowStep {
  key: 'upload' | 'parse' | 'translate'
  label: string
  state: WorkflowStepState
}

/** Translated block count as "n/total", when the translation has started counting. */
export function translationCount(workflow: Workflow): string | null {
  const progress = workflow.translationProgress
  return progress && progress.totalBlocks > 0 ? `${progress.completedBlocks}/${progress.totalBlocks}` : null
}

/** The three steps of a paper's processing, "上傳 → 解析 → 翻譯 n/總數", for progress displays. */
export function workflowSteps(workflow: Workflow): WorkflowStep[] {
  const count = translationCount(workflow)
  const translate = count ? `翻譯 ${count}` : '翻譯'
  const states = ((): [WorkflowStepState, WorkflowStepState, WorkflowStepState] => {
    switch (workflow.status) {
      case 'uploading': return ['active', 'waiting', 'waiting']
      case 'parsing': return ['done', 'active', 'waiting']
      case 'queued': return ['done', 'done', 'waiting']
      case 'translating': return ['done', 'done', 'active']
      case 'partial': return ['done', 'done', 'partial']
      case 'completed': return ['done', 'done', 'done']
      case 'failed':
        if (workflow.translationProgress) return ['done', 'done', 'failed']
        // Parse progress stays below 10 until the PDF has been uploaded.
        return workflow.progress < 10 ? ['failed', 'waiting', 'waiting'] : ['done', 'failed', 'waiting']
    }
  })()
  return [
    { key: 'upload', label: '上傳', state: states[0] },
    { key: 'parse', label: '解析', state: states[1] },
    { key: 'translate', label: translate, state: states[2] }
  ]
}

/** One line for a paper's current step, such as "正在解析" or "正在翻譯 12/80". */
export function workflowSummaryText(workflow: Workflow): string {
  const count = translationCount(workflow)
  switch (workflow.status) {
    case 'uploading': return '正在上傳 PDF'
    case 'parsing': return '正在解析'
    case 'queued': return '解析完成，等待翻譯'
    case 'translating': return count ? `正在翻譯 ${count}` : '正在翻譯'
    case 'partial': {
      const failed = workflow.translationProgress?.failedBlocks ?? 0
      return failed > 0 ? `部分翻譯完成，${failed} 段失敗` : '部分翻譯完成'
    }
    case 'completed': return '已完成'
    case 'failed': return workflowSteps(workflow).find((step) => step.state === 'failed')?.key === 'translate'
      ? '翻譯失敗' : workflowSteps(workflow)[0]!.state === 'failed' ? '上傳失敗' : '解析失敗'
  }
}
