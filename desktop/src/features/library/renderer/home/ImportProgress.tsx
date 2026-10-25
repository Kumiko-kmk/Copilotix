import React from 'react'
import { AppstoreOutlined, CloseOutlined, ReadOutlined } from '@ant-design/icons'
import type { DocumentSummary } from '@shared/ipcSchemas'
import { originalAvailable } from '../documentStatus'
import WorkflowSteps from '../WorkflowSteps'

/** Rows beyond this are summarised; the library lists every paper. */
const VISIBLE_ROWS = 4

/**
 * Home-page card for papers being processed: just imported ones and any still running from before.
 * Each row shows 上传 → 解析 → 翻译 n/总数 and opens the paper once its original can be read.
 */
export default function ImportProgress(props: {
  documents: readonly DocumentSummary[]
  onOpenReader(documentId: string): void
  onShowInLibrary(documentId: string): void
  onDismiss(documentId: string): void
}): React.JSX.Element | null {
  if (props.documents.length === 0) return null
  const visible = props.documents.slice(0, VISIBLE_ROWS)
  const hidden = props.documents.length - visible.length
  return (
    <section className="import-progress" aria-label="导入进度">
      <header className="import-progress-header">
        <span className="eyebrow">导入进度</span>
        {hidden > 0 ? <small>另有 {hidden} 篇，可在文库查看</small> : null}
      </header>
      <ul>
        {visible.map((document) => {
          const readable = originalAvailable(document.workflow)
          const title = document.displayName.replace(/\.pdf\s*$/iu, '').trim()
          return (
            <li key={document.id} className="import-progress-row" data-document-id={document.id} data-status={document.workflow.status}>
              <div className="import-progress-text">
                <strong>{title}</strong>
                <WorkflowSteps workflow={document.workflow} />
                {document.workflow.status === 'failed' && document.workflow.error
                  ? <small className="import-progress-error">{document.workflow.error}</small> : null}
              </div>
              <div className="import-progress-actions">
                <button type="button" className="import-progress-action" disabled={!readable} onClick={() => props.onOpenReader(document.id)}>
                  <ReadOutlined aria-hidden="true" /><span>{readable ? '打开阅读' : '解析后可读'}</span>
                </button>
                <button type="button" className="import-progress-action" onClick={() => props.onShowInLibrary(document.id)}>
                  <AppstoreOutlined aria-hidden="true" /><span>在文库查看</span>
                </button>
                <button type="button" className="import-progress-dismiss" aria-label={`从导入进度中移除 ${title}`} onClick={() => props.onDismiss(document.id)}>
                  <CloseOutlined aria-hidden="true" />
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
