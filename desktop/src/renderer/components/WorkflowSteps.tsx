import React from 'react'
import type { DocumentSummary } from '@shared/ipcSchemas'
import { workflowSteps, workflowSummaryText, type WorkflowStepState } from '../documentStatus'

const STATE_TEXT: Record<WorkflowStepState, string> = {
  done: '已完成', active: '进行中', waiting: '未开始', failed: '失败', partial: '部分完成'
}

/** "上传 → 解析 → 翻译 n/总数", with the current step marked; the whole line is one status for screen readers. */
export default function WorkflowSteps(props: { workflow: DocumentSummary['workflow']; className?: string }): React.JSX.Element {
  const steps = workflowSteps(props.workflow)
  return (
    <span className={`workflow-steps${props.className ? ` ${props.className}` : ''}`} role="status" aria-label={workflowSummaryText(props.workflow)}>
      {steps.map((step, index) => (
        <React.Fragment key={step.key}>
          {index > 0 ? <span className="workflow-step-arrow" aria-hidden="true">→</span> : null}
          <span className="workflow-step" data-state={step.state} aria-label={`${step.label}${STATE_TEXT[step.state]}`}>
            {step.state === 'done' ? <span className="workflow-step-check" aria-hidden="true">✓</span> : null}
            {step.label}
          </span>
        </React.Fragment>
      ))}
    </span>
  )
}
