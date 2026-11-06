import React from 'react'
import { SettingsDialog } from '@features/settings/renderer'
// Direct import: the reader barrel re-exports Markdown rendering (KaTeX CSS) that must stay in the lazy reader chunk.
import { loadReaderPage } from '@features/reader/renderer/readerPageLoader'
import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons'
import type { DocumentSummary } from '@features/library/contract/documentSchemas'
import { NewParsePage, PaperSidebar } from '@features/library/renderer'
import WindowControls from './WindowControls'
import { useAppData } from './useAppData'
import { useGuardedViews } from './useGuardedViews'
import './lite.css'

const ReaderPage = React.lazy(loadReaderPage)

type PageView = { name: 'home' } | { name: 'reader'; documentId: string }
/** Settings open in a window over the page they came from, which stays mounted and is returned to as it was. */
type View = PageView | { name: 'settings'; under: PageView }

const SIDEBAR_COLLAPSED_KEY = 'copilotix.lite.sidebar-collapsed.v1'

function storedSidebarCollapsed(): boolean {
  try { return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1' } catch { return false }
}

function isEditing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
}

/** The reading-only edition: a paper list instead of the top navigation, nothing else around the reader. */
export default function LiteApp(): React.JSX.Element {
  const { view, requestViewChange, onNavigationGuardChange, guardDialog } = useGuardedViews<View>({ name: 'home' })
  const { settings, documents, mergeImported, onSettingsSaved } = useAppData()
  const [collapsed, setCollapsed] = React.useState(storedSidebarCollapsed)
  const page: PageView = view.name === 'settings' ? view.under : view
  const settingsOpen = view.name === 'settings'

  const toggleSidebar = React.useCallback(() => {
    setCollapsed((current) => {
      try { window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, current ? '0' : '1') } catch { /* Stays for this session only. */ }
      return !current
    })
  }, [])
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b' && !isEditing(event.target)) {
        event.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleSidebar])

  const openSettings = React.useCallback(() => {
    requestViewChange({ name: 'settings', under: page })
  }, [page, requestViewChange])
  const openPaper = React.useCallback((documentId: string) => requestViewChange({ name: 'reader', documentId }), [requestViewChange])
  const goHome = React.useCallback(() => requestViewChange({ name: 'home' }), [requestViewChange])
  React.useEffect(() => window.copilotix.onOpenDocument(openPaper), [openPaper])

  const onImported = React.useCallback((created: DocumentSummary[]) => {
    mergeImported(created)
    // Like sending a first message: a single new paper opens right away, the PDF readable while it parses.
    if (created.length === 1) openPaper(created[0]!.id)
  }, [mergeImported, openPaper])

  return (
    <div className="app-shell lite-shell" data-sidebar={collapsed ? 'collapsed' : 'expanded'}>
      <div className="lite-body" inert={settingsOpen ? true : undefined}>
        {collapsed ? null : <PaperSidebar documents={documents} activeDocumentId={page.name === 'reader' ? page.documentId : null} onNew={goHome} onOpen={openPaper} onOpenSettings={openSettings} />}
        <main className="main-surface lite-main">
          {page.name === 'home' && settings ? (
            <>
              <div className="lite-drag-strip" aria-hidden="true" />
              <NewParsePage settings={settings} onCreated={onImported} onOpenSettings={openSettings} />
            </>
          ) : null}
          {page.name === 'reader' ? (
            <React.Suspense fallback={<div className="reader-loading">正在加载阅读器…</div>}>
              {/* Keyed: each paper has its own view state and resumes where it was, the workbench layout is shared. */}
              <ReaderPage key={page.documentId} documentId={page.documentId} showBack={false} resumePosition onBack={goHome} onOpenSettings={openSettings} />
            </React.Suspense>
          ) : null}
          {!settings && page.name === 'home' ? <div className="page-loading">正在加载…</div> : null}
        </main>
      </div>
      {settings ? (
        <SettingsDialog open={settingsOpen} settings={settings} onSaved={onSettingsSaved} onNavigationGuardChange={onNavigationGuardChange}
          onClose={() => { if (view.name === 'settings') requestViewChange(view.under) }} />
      ) : null}
      {/* After the page: Chromium applies drag regions in document order, so these must come later to stay clickable. */}
      <div className="edge-dock-persistent"><WindowControls /></div>
      {settingsOpen ? null : (
        <button type="button" className="lite-sidebar-toggle" aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'} aria-expanded={!collapsed} onClick={toggleSidebar}>
          {collapsed ? <MenuUnfoldOutlined aria-hidden="true" /> : <MenuFoldOutlined aria-hidden="true" />}
        </button>
      )}
      {guardDialog}
    </div>
  )
}
