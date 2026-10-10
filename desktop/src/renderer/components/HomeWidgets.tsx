import React from 'react'
import { ArrowRightOutlined } from '@ant-design/icons'
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

/** A hairline along the card's foot: filled to the progress while active, full in the status colour otherwise. */
function StatusLine(props: { status: WorkflowStatus; progress: number }): React.JSX.Element {
  const progress = ACTIVE_STATUSES.has(props.status) ? Math.max(0, Math.min(100, props.progress)) : 100
  return <span className="shelf-progress" aria-hidden="true"><i style={{ width: `${progress}%` }} /></span>
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
        <span className="eyebrow">CONTINUE / 继续阅读</span>
        <button type="button" onClick={props.onViewAll}><span>全部 {props.documents.length} 篇</span><ArrowRightOutlined aria-hidden="true" /></button>
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
              aria-label={`打开论文：${document.displayName}，${STATUS_LABELS[status]}${progress}`}
              onClick={() => props.onOpen(document.id)}
            >
              <span className="shelf-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <span className="shelf-copy">
                <strong>{document.displayName.replace(/\.pdf$/iu, '')}</strong>
                <small><i aria-hidden="true" />{STATUS_LABELS[status]}{progress} · {relativeTime(document.updatedAt)}</small>
              </span>
              <StatusLine status={status} progress={document.workflow.progress} />
            </button>
          )
        })}
      </div>
    </section>
  )
}
