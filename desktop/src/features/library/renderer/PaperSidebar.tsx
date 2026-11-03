import React from 'react'
import { PlusOutlined, SettingOutlined } from '@ant-design/icons'
import type { DocumentSummary } from '../contract/documentSchemas'
import { statusLabels, translationCount } from './documentStatus'

/** Papers kept like conversations in an agent app: one click switches, newest import first. */
export default function PaperSidebar(props: {
  documents: readonly DocumentSummary[]
  activeDocumentId: string | null
  onNew(): void
  onOpen(documentId: string): void
  onOpenSettings(): void
}): React.JSX.Element {
  const papers = React.useMemo(() => [...props.documents].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [props.documents])
  return (
    <aside className="paper-sidebar">
      <div className="paper-sidebar-head" aria-hidden="true" />
      <nav className="paper-sidebar-nav" aria-label="论文导航">
        <button type="button" className="paper-sidebar-action" aria-current={props.activeDocumentId === null ? 'page' : undefined} onClick={props.onNew}>
          <PlusOutlined aria-hidden="true" /><span>新建</span>
        </button>
        {papers.length > 0 ? (
          <ul className="paper-sidebar-list">
            {papers.map((paper) => {
              const status = paperStatus(paper)
              return (
                <li key={paper.id}>
                  <button type="button" className="paper-sidebar-item" data-document-id={paper.id} data-status={paper.workflow.status} aria-current={paper.id === props.activeDocumentId ? 'page' : undefined} onClick={() => props.onOpen(paper.id)}>
                    <span className="paper-sidebar-title">{paper.displayName.replace(/\.pdf\s*$/iu, '').trim()}</span>
                    {status ? <small>{status}</small> : null}
                  </button>
                </li>
              )
            })}
          </ul>
        ) : <p className="paper-sidebar-empty">导入的论文会显示在这里</p>}
      </nav>
      <button type="button" className="paper-sidebar-action paper-sidebar-settings" onClick={props.onOpenSettings}>
        <SettingOutlined aria-hidden="true" /><span>设置</span>
      </button>
    </aside>
  )
}

/** Finished papers show nothing, so the list only speaks up about work still going on or stopped. */
function paperStatus(paper: DocumentSummary): string | null {
  const { workflow } = paper
  if (workflow.status === 'completed') return null
  const count = workflow.status === 'translating' ? translationCount(workflow) : null
  return count ? `${statusLabels[workflow.status]} ${count}` : statusLabels[workflow.status]
}
