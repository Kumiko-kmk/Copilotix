import React from 'react'
import type { DocumentSummary } from '@shared/ipcSchemas'

const statusLabels: Record<DocumentSummary['workflow']['status'], string> = {
  queued: '排队中',
  uploading: '上传中',
  parsing: '解析中',
  translating: '翻译中',
  partial: '部分完成',
  completed: '已完成',
  failed: '失败'
}
const progressStatuses = new Set<DocumentSummary['workflow']['status']>(['queued', 'uploading', 'parsing', 'translating'])

interface PaperSwitcherProps {
  documents: DocumentSummary[]
  activeDocumentId: string | null
  onOpen(documentId: string): void
}

export default function PaperSwitcher(props: PaperSwitcherProps): React.JSX.Element {
  if (props.documents.length === 0) {
    return <div className="paper-switcher-empty">暂无论文</div>
  }

  return (
    <nav className="paper-switcher" aria-label="论文切换">
      {props.documents.map((document) => {
        const active = document.id === props.activeDocumentId
        const progress = progressStatuses.has(document.workflow.status) ? ` · ${document.workflow.progress}%` : ''
        return (
          <button
            key={document.id}
            type="button"
            className={`paper-switcher-item${active ? ' active' : ''}`}
            data-testid="paper-switcher-item"
            data-paper-task-id={document.id}
            title={document.displayName}
            aria-label={`打开论文：${document.displayName}，${statusLabels[document.workflow.status]}${progress}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => props.onOpen(document.id)}
          >
            <span className="paper-switcher-name">{document.displayName}</span>
            <span className={`paper-switcher-status status-${document.workflow.status}`}>{statusLabels[document.workflow.status]}{progress}</span>
          </button>
        )
      })}
    </nav>
  )
}
