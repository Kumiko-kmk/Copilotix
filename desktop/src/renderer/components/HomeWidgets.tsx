import React from 'react'
import { CheckOutlined, CloseOutlined, ExclamationOutlined, FileSearchOutlined, ReadOutlined, TranslationOutlined } from '@ant-design/icons'
import type { DocumentSummary } from '@shared/ipcSchemas'

type WorkflowStatus = DocumentSummary['workflow']['status']

const STATUS_LABELS: Record<WorkflowStatus, string> = {
  queued: '排队中', uploading: '上传中', parsing: '解析中', translating: '翻译中',
  partial: '部分完成', completed: '已完成', failed: '失败'
}
const ACTIVE_STATUSES = new Set<WorkflowStatus>(['queued', 'uploading', 'parsing', 'translating'])
const WEEKDAYS = '日一二三四五六'

export function greetingFor(date: Date): string {
  const hour = date.getHours()
  const greeting = hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好'
  return `${greeting} · ${date.getMonth() + 1}月${date.getDate()}日 星期${WEEKDAYS[date.getDay()]}`
}

export function HomeGreeting(): React.JSX.Element {
  const [text] = React.useState(() => greetingFor(new Date()))
  return <p className="home-greeting"><i aria-hidden="true" />{text}</p>
}

const PIPELINE_STEPS = [
  { label: '解析版面', icon: <FileSearchOutlined /> },
  { label: '逐段翻译', icon: <TranslationOutlined /> },
  { label: '原文译文对照阅读', icon: <ReadOutlined /> }
] as const

/** Three-stage workflow strip; a spark travels between stages and lights each one in turn. */
export function HomePipeline(): React.JSX.Element {
  return (
    <div className="home-pipeline" role="list" aria-label="Copilotix 工作流程">
      {PIPELINE_STEPS.map((step, index) => (
        <React.Fragment key={step.label}>
          {index > 0 ? <span className="pipeline-link" aria-hidden="true" style={{ '--i': index - 1 } as React.CSSProperties}><i /></span> : null}
          <span className="pipeline-step" role="listitem" style={{ '--i': index } as React.CSSProperties}>
            <span className="pipeline-node" aria-hidden="true">{step.icon}</span>
            <span>{step.label}</span>
          </span>
        </React.Fragment>
      ))}
    </div>
  )
}

export function relativeTime(value: string, now = Date.now()): string {
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return ''
  const minutes = Math.floor((now - time) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))} 天前`
  const date = new Date(time)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

function StatusBadge(props: { status: WorkflowStatus; progress: number }): React.JSX.Element {
  if (ACTIVE_STATUSES.has(props.status)) {
    const progress = Math.max(0, Math.min(100, props.progress))
    return (
      <svg className="shelf-ring" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="shelf-ring-track" cx="12" cy="12" r="9.5" />
        <circle className="shelf-ring-value" cx="12" cy="12" r="9.5" pathLength="100" style={{ strokeDasharray: `${progress} 100` }} />
      </svg>
    )
  }
  const icon = props.status === 'completed' ? <CheckOutlined /> : props.status === 'failed' ? <CloseOutlined /> : <ExclamationOutlined />
  return <span className="shelf-badge" aria-hidden="true">{icon}</span>
}

/** "Continue reading" shelf with the three most recently touched papers. */
export function RecentShelf(props: {
  documents: DocumentSummary[]
  onOpen(documentId: string): void
  onViewAll(): void
}): React.JSX.Element | null {
  const recent = React.useMemo(
    () => [...props.documents].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 3),
    [props.documents]
  )
  if (recent.length === 0) return null
  return (
    <section className="recent-shelf" aria-label="继续阅读">
      <header className="recent-shelf-header">
        <span>继续阅读</span>
        <button type="button" onClick={props.onViewAll}>全部 {props.documents.length} 篇 <span aria-hidden="true">→</span></button>
      </header>
      <div className="recent-shelf-list">
        {recent.map((document, index) => {
          const status = document.workflow.status
          const progress = ACTIVE_STATUSES.has(status) ? ` · ${document.workflow.progress}%` : ''
          return (
            <button
              key={document.id}
              type="button"
              className={`shelf-card status-${status}`}
              style={{ '--i': index } as React.CSSProperties}
              title={document.displayName}
              aria-label={`打开论文：${document.displayName}，${STATUS_LABELS[status]}${progress}`}
              onClick={() => props.onOpen(document.id)}
            >
              <span className="shelf-thumb" aria-hidden="true"><i /></span>
              <span className="shelf-copy">
                <strong>{document.displayName.replace(/\.pdf$/iu, '')}</strong>
                <small>{STATUS_LABELS[status]}{progress} · {relativeTime(document.updatedAt)}</small>
              </span>
              <StatusBadge status={status} progress={document.workflow.progress} />
            </button>
          )
        })}
      </div>
    </section>
  )
}
