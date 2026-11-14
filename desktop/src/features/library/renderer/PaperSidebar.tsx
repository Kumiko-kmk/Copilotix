import React from 'react'
import { CloseOutlined, PlusOutlined, PushpinOutlined, RightOutlined, SearchOutlined, SettingOutlined } from '@ant-design/icons'
import { Dropdown, message, type MenuProps } from 'antd'
import type { DocumentSummary } from '../contract/documentSchemas'
import { statusLabels, translationCount } from './documentStatus'
import { matchesTitleSearch } from '../core/titleSearch'
import { prunePins, sidebarSections } from '../core/sidebarSections'
import { useSidebarPrefs } from './sidebar/useSidebarPrefs'
import { usePaperCategories } from './sidebar/usePaperCategories'
import DeletePaperDialog from './sidebar/DeletePaperDialog'

/**
 * Papers kept like conversations in an agent app: one click switches, pinned papers on top, the rest
 * grouped by what they are about. Right-click (or the menu key) opens a paper's actions.
 */
export default function PaperSidebar(props: {
  documents: readonly DocumentSummary[]
  activeDocumentId: string | null
  /** The paper shown beside the active one, if the reader is split. */
  splitDocumentId?: string | null
  onNew(): void
  onOpen(documentId: string): void
  /** A pointer resting on a paper: read it ahead so the click finds it ready. */
  onPrefetch?(documentId: string): void
  onOpenSettings(): void
  onOpenInWindow?(documentId: string): void
  onOpenInSplit?(documentId: string): void
  onDeleted?(documentId: string): void
}): React.JSX.Element {
  const [messageApi, contextHolder] = message.useMessage()
  const [searching, setSearching] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [renaming, setRenaming] = React.useState<string | null>(null)
  const [menuTarget, setMenuTarget] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<DocumentSummary | null>(null)
  const pendingMenuTarget = React.useRef<string | null>(null)
  const input = React.useRef<HTMLInputElement>(null)
  const prefs = useSidebarPrefs()
  const categories = usePaperCategories(props.documents)
  const { replacePins } = prefs
  React.useEffect(() => {
    if (props.documents.length) replacePins(prunePins(prefs.pins, new Set(props.documents.map((paper) => paper.id))))
  }, [prefs.pins, props.documents, replacePins])
  const sections = React.useMemo(() => sidebarSections(props.documents, categories, prefs.pins), [categories, prefs.pins, props.documents])
  const matches = React.useMemo(() => query.trim()
    ? [...props.documents].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).filter(paper => matchesTitleSearch([paper.displayName, paper.originalName ?? ''], query))
    : [], [props.documents, query])
  React.useEffect(() => { if (searching) input.current?.focus() }, [searching])
  const closeSearch = (): void => { setSearching(false); setQuery('') }
  const prefetchTimer = React.useRef<number | undefined>(undefined)
  const hover = (documentId: string | null): void => {
    window.clearTimeout(prefetchTimer.current)
    if (documentId && props.onPrefetch) prefetchTimer.current = window.setTimeout(() => props.onPrefetch?.(documentId), 120)
  }
  React.useEffect(() => () => window.clearTimeout(prefetchTimer.current), [])

  const rename = async (paper: DocumentSummary, title: string): Promise<void> => {
    setRenaming(null)
    const next = title.trim()
    if (!next || next === paperTitle(paper)) return
    try {
      await window.copilotix.renameDocument({ documentId: paper.id, title: next })
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    }
  }
  const target = menuTarget ? props.documents.find((paper) => paper.id === menuTarget) : undefined
  const groupedTarget = target ? sections.find((section) => section.papers.some((paper) => paper.id === target.id)) : undefined
  const menuItems: MenuProps['items'] = target ? [
    { key: 'window', label: '在新視窗中開啟' },
    { key: 'split', label: '分屏開啟', disabled: target.id === props.activeDocumentId || target.id === props.splitDocumentId },
    { type: 'divider' },
    { key: 'rename', label: '重新命名' },
    { key: 'pin', label: prefs.pins.global.includes(target.id) ? '取消置頂' : '置頂' },
    ...(groupedTarget?.kind === 'category' || prefs.pins.group.includes(target.id)
      ? [{ key: 'pin-group', label: prefs.pins.group.includes(target.id) ? '取消分組內置頂' : '在分組內置頂' }]
      : []),
    { type: 'divider' },
    { key: 'delete', label: '刪除', danger: true }
  ] : []
  const onMenu = (key: string, paper: DocumentSummary): void => {
    setMenuTarget(null)
    if (key === 'window') props.onOpenInWindow?.(paper.id)
    else if (key === 'split') props.onOpenInSplit?.(paper.id)
    else if (key === 'rename') setRenaming(paper.id)
    else if (key === 'pin') prefs.togglePin(paper.id, 'global')
    else if (key === 'pin-group') prefs.togglePin(paper.id, 'group')
    else if (key === 'delete') setDeleting(paper)
  }

  const item = (paper: DocumentSummary): React.JSX.Element => {
    if (renaming === paper.id) return <li key={paper.id}><RenameInput paper={paper} onDone={(title) => void rename(paper, title)} onCancel={() => setRenaming(null)} /></li>
    const status = paperStatus(paper)
    return (
      <li key={paper.id}>
        <button type="button" className="paper-sidebar-item" data-document-id={paper.id} data-status={paper.workflow.status}
          aria-current={paper.id === props.activeDocumentId ? 'page' : undefined} data-menu-open={paper.id === menuTarget ? 'true' : undefined} data-open={paper.id === props.splitDocumentId ? 'true' : undefined}
          onClick={() => props.onOpen(paper.id)} onPointerEnter={() => hover(paper.id)} onPointerLeave={() => hover(null)} onFocus={() => hover(paper.id)}
          onKeyDown={(event) => {
            if (event.key === 'F2') { event.preventDefault(); setRenaming(paper.id) }
            else if (event.key === 'Delete') { event.preventDefault(); setDeleting(paper) }
          }}>
          <span className="paper-sidebar-title">{paperTitle(paper)}</span>
          {prefs.pins.group.includes(paper.id) ? <PushpinOutlined className="paper-sidebar-pin" aria-hidden="true" /> : null}
          {status ? <small>{status}</small> : null}
        </button>
      </li>
    )
  }
  // A lone section of papers the categories do not cover yet needs no heading.
  const headed = sections.length > 1 || sections[0]?.kind !== 'new'
  return (
    <aside className="paper-sidebar">
      {contextHolder}
      <div className="paper-sidebar-head" aria-hidden="true" />
      <nav className="paper-sidebar-nav" aria-label="論文導覽">
        <div className="paper-sidebar-actions">
          <button type="button" className="paper-sidebar-action" aria-current={props.activeDocumentId === null ? 'page' : undefined} onClick={props.onNew}>
            <PlusOutlined aria-hidden="true" /><span>新建</span>
          </button>
          <button type="button" className="paper-sidebar-search-toggle" aria-label={searching ? '關閉搜尋' : '搜尋論文'} aria-expanded={searching} onClick={() => searching ? closeSearch() : setSearching(true)}>
            {searching ? <CloseOutlined aria-hidden="true" /> : <SearchOutlined aria-hidden="true" />}
          </button>
        </div>
        {searching ? <input ref={input} type="search" className="paper-sidebar-search" aria-label="搜尋論文標題" placeholder="搜尋標題" value={query}
          onChange={event => setQuery(event.target.value)} onKeyDown={event => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Escape') { event.stopPropagation(); closeSearch() }
            if (event.key === 'Enter' && matches[0]) { event.preventDefault(); props.onOpen(matches[0].id) }
          }} /> : null}
        <Dropdown trigger={['contextMenu']} open={Boolean(target)} destroyOnHidden
          onOpenChange={(open) => setMenuTarget(open ? pendingMenuTarget.current : null)}
          menu={{ items: menuItems, onClick: ({ key, domEvent }) => { domEvent.stopPropagation(); if (target) onMenu(key, target) } }}>
          <div className="paper-sidebar-scroll" onContextMenuCapture={(event) => {
            const element = (event.target as HTMLElement).closest<HTMLElement>('[data-document-id]')
            pendingMenuTarget.current = element?.dataset.documentId ?? null
            // Right-clicking another paper while the menu is open moves the menu to it.
            if (element && menuTarget) setMenuTarget(pendingMenuTarget.current)
            if (!element) event.preventDefault()
          }}>
            {query.trim() ? (
              matches.length ? <ul className="paper-sidebar-list">{matches.map(item)}</ul> : <p className="paper-sidebar-empty" role="status">沒有匹配的論文</p>
            ) : !headed && sections[0] ? (
              <ul className="paper-sidebar-list">{sections[0].papers.map(item)}</ul>
            ) : sections.length ? (
              <ul className="paper-sidebar-list">
                {sections.map((section) => {
                  const folded = prefs.collapsed.has(section.key)
                  return (
                    <li key={section.key} className="paper-sidebar-section" data-section={section.kind}>
                      <button type="button" className="paper-sidebar-section-head" aria-expanded={!folded} onClick={() => prefs.toggleSection(section.key)}>
                        <span>{section.name}</span><RightOutlined className="paper-sidebar-section-chevron" aria-hidden="true" />
                      </button>
                      {folded ? null : <ul className="paper-sidebar-group" aria-label={section.name}>{section.papers.map(item)}</ul>}
                    </li>
                  )
                })}
              </ul>
            ) : <p className="paper-sidebar-empty" role="status">匯入的論文會顯示在這裡</p>}
          </div>
        </Dropdown>
      </nav>
      <button type="button" className="paper-sidebar-action paper-sidebar-settings" onClick={props.onOpenSettings}>
        <SettingOutlined aria-hidden="true" /><span>設定</span>
      </button>
      <DeletePaperDialog paper={deleting} messageApi={messageApi} onClose={() => setDeleting(null)} onDeleted={(id) => props.onDeleted?.(id)} />
    </aside>
  )
}

/** Edits a title in place: Enter or leaving the field saves, Escape keeps the old one. */
function RenameInput(props: { paper: DocumentSummary; onDone(title: string): void; onCancel(): void }): React.JSX.Element {
  const ref = React.useRef<HTMLInputElement>(null)
  const settled = React.useRef(false)
  React.useEffect(() => {
    // After the menu that asked for it has closed and let go of focus.
    const frame = window.requestAnimationFrame(() => { ref.current?.focus(); ref.current?.select() })
    return () => window.cancelAnimationFrame(frame)
  }, [])
  const finish = (save: boolean): void => {
    if (settled.current) return
    settled.current = true
    if (save) props.onDone(ref.current?.value ?? '')
    else props.onCancel()
  }
  return (
    <input ref={ref} className="paper-sidebar-rename" aria-label="論文標題" defaultValue={paperTitle(props.paper)} maxLength={200}
      onBlur={() => finish(true)} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') { event.preventDefault(); finish(true) }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false) }
      }} />
  )
}

function paperTitle(paper: DocumentSummary): string {
  return paper.displayName.replace(/\.pdf\s*$/iu, '').trim()
}

/** Finished papers show nothing, so the list only speaks up about work still going on or stopped. */
function paperStatus(paper: DocumentSummary): string | null {
  const { workflow } = paper
  if (workflow.status === 'completed') return null
  const count = workflow.status === 'translating' ? translationCount(workflow) : null
  return count ? `${statusLabels[workflow.status]} ${count}` : statusLabels[workflow.status]
}
