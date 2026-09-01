import React from 'react'
import type { MinerUTask, TaskStatus } from '@shared/types'

const statusLabels: Record<TaskStatus, string> = {
  uploading: '上传中',
  parsing: '解析中',
  translating: '翻译中',
  partial: '部分完成',
  completed: '已完成',
  failed: '失败'
}

const progressStatuses = new Set<TaskStatus>(['uploading', 'parsing', 'translating'])

interface PaperSwitcherProps {
  tasks: MinerUTask[]
  activeTaskId: string | null
  onOpen(taskId: string): void
}

export default function PaperSwitcher(props: PaperSwitcherProps): React.JSX.Element {
  if (props.tasks.length === 0) {
    return <div className="paper-switcher-empty">暂无论文</div>
  }

  return (
    <nav className="paper-switcher" aria-label="论文切换">
      {props.tasks.map((task) => {
        const active = task.id === props.activeTaskId
        const progress = progressStatuses.has(task.status) ? ` · ${task.progress}%` : ''
        return (
          <button
            key={task.id}
            type="button"
            className={`paper-switcher-item${active ? ' active' : ''}`}
            data-testid="paper-switcher-item"
            data-paper-task-id={task.id}
            title={task.name}
            aria-label={`打开论文：${task.name}，${statusLabels[task.status]}${progress}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => props.onOpen(task.id)}
          >
            <span className="paper-switcher-name">{task.name}</span>
            <span className={`paper-switcher-status status-${task.status}`}>{statusLabels[task.status]}{progress}</span>
          </button>
        )
      })}
    </nav>
  )
}
