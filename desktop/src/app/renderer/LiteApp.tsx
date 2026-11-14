import React from 'react'
import { loadSettingsDialog } from '@features/settings/renderer'
// Direct import: the reader barrel re-exports Markdown rendering (KaTeX CSS) that must stay in the lazy reader chunk.
import { loadReaderPage, prefetchReaderDocument } from '@features/reader/renderer/readerPageLoader'
import { useQueryClient } from '@tanstack/react-query'
import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons'
import type { DocumentSummary } from '@features/library/contract/documentSchemas'
import { NewParsePage, PaperSidebar } from '@features/library/renderer'
import WindowControls from './WindowControls'
import LiteSplitHandle from './LiteSplitHandle'
import AppleLoader from '@platform/ui/renderer/AppleLoader'
import { useAppData } from './useAppData'
import { useGuardedViews } from './useGuardedViews'
import './lite.css'

const ReaderPage = React.lazy(loadReaderPage)
/** Re-renders only when its own paper or callbacks change, not when another kept reader becomes the open one. */
const KeptReader = React.memo(function KeptReader(props: { documentId: string; onBack(): void; onOpenSettings(): void }) {
  return <ReaderPage documentId={props.documentId} showBack={false} resumePosition onBack={props.onBack} onOpenSettings={props.onOpenSettings} />
})
const SettingsDialog = React.lazy(loadSettingsDialog)

type PageView = { name: 'home' } | { name: 'reader'; documentId: string }
/** Settings open in a window over the page they came from, which stays mounted and is returned to as it was. */
type View = PageView | { name: 'settings'; under: PageView }

const SIDEBAR_COLLAPSED_KEY = 'copilotix.lite.sidebar-collapsed.v1'
/** Readers kept mounted, most recent first: going back to one of them is immediate. */
const KEPT_READERS = 3

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
  const queryClient = useQueryClient()
  const activeDocumentId = page.name === 'reader' ? page.documentId : null
  /** A second paper beside the open one; the sidebar opens papers into whichever pane was used last. */
  const [split, setSplit] = React.useState<{ documentId: string; ratio: number; focused: boolean } | null>(null)
  const [keptReaders, setKeptReaders] = React.useState<readonly string[]>([])
  // The open paper joins the kept readers in this render, so it never waits a frame for the effect below.
  // The split paper is never also kept on the left: one paper, one reader.
  const readers = (activeDocumentId && !keptReaders.includes(activeDocumentId) ? [activeDocumentId, ...keptReaders].slice(0, KEPT_READERS) : keptReaders)
    .filter((id) => id !== split?.documentId)
  React.useEffect(() => {
    if (!activeDocumentId) return
    setKeptReaders((current) => [activeDocumentId, ...current.filter((id) => id !== activeDocumentId)].slice(0, KEPT_READERS))
  }, [activeDocumentId])
  // A deleted paper's reader goes too.
  React.useEffect(() => {
    const ids = new Set(documents.map((document) => document.id))
    setKeptReaders((current) => current.every((id) => ids.has(id)) ? current : current.filter((id) => ids.has(id)))
    setSplit((current) => current && !ids.has(current.documentId) && documents.length ? null : current)
  }, [documents])
  const prefetchPaper = React.useCallback((documentId: string) => { void prefetchReaderDocument(queryClient, documentId) }, [queryClient])
  // Once the window is up, fetch the reader and settings code while idle, so neither waits on first use.
  React.useEffect(() => {
    const warm = (): void => { void loadReaderPage().catch(() => undefined); void loadSettingsDialog().catch(() => undefined) }
    const handle = window.requestIdleCallback ? window.requestIdleCallback(warm, { timeout: 2000 }) : window.setTimeout(warm, 1200)
    return () => { if (window.cancelIdleCallback) window.cancelIdleCallback(handle); else window.clearTimeout(handle) }
  }, [])

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

  // Stable across navigation: the kept readers receive it, and a new function would re-render all of them.
  const pageRef = React.useRef(page)
  pageRef.current = page
  const openSettings = React.useCallback(() => {
    requestViewChange({ name: 'settings', under: pageRef.current })
  }, [requestViewChange])
  const showPaper = React.useCallback((documentId: string) => {
    // Opening the split paper on the left closes the split instead of showing it twice.
    setSplit((current) => current?.documentId === documentId ? null : current)
    requestViewChange({ name: 'reader', documentId })
  }, [requestViewChange])
  const goHome = React.useCallback(() => requestViewChange({ name: 'home' }), [requestViewChange])
  React.useEffect(() => window.copilotix.onOpenDocument(showPaper), [showPaper])
  // A window opened for one paper starts on it.
  React.useEffect(() => { void window.copilotix.initialDocument().then((documentId) => { if (documentId) showPaper(documentId) }, () => undefined) }, [showPaper])
  const splitRef = React.useRef(split)
  splitRef.current = split
  const activeDocumentIdRef = React.useRef(activeDocumentId)
  activeDocumentIdRef.current = activeDocumentId
  /** A paper chosen in the sidebar replaces the one in the pane used last. */
  const openPaper = React.useCallback((documentId: string) => {
    const current = splitRef.current
    if (current?.focused && activeDocumentIdRef.current) {
      if (documentId === activeDocumentIdRef.current) setSplit({ ...current, focused: false })
      else if (documentId !== current.documentId) setSplit({ ...current, documentId })
      return
    }
    showPaper(documentId)
  }, [showPaper])
  const openSplit = React.useCallback((documentId: string) => {
    if (!activeDocumentIdRef.current) { showPaper(documentId); return }
    if (documentId === activeDocumentIdRef.current) return
    setKeptReaders((current) => current.filter((id) => id !== documentId))
    setSplit((current) => ({ documentId, ratio: current?.ratio ?? 0.5, focused: true }))
  }, [showPaper])
  const closeSplit = React.useCallback(() => setSplit(null), [])
  const focusPane = (focused: boolean): void => setSplit((current) => current && current.focused !== focused ? { ...current, focused } : current)
  const onDeleted = React.useCallback((documentId: string) => {
    setSplit((current) => current?.documentId === documentId ? null : current)
    if (activeDocumentIdRef.current === documentId) goHome()
  }, [goHome])
  const openInWindow = React.useCallback((documentId: string) => { void window.copilotix.openDocumentWindow(documentId) }, [])

  const onImported = React.useCallback((created: DocumentSummary[]) => {
    mergeImported(created)
    // Like sending a first message: a single new paper opens right away, the PDF readable while it parses.
    if (created.length === 1) showPaper(created[0]!.id)
  }, [mergeImported, showPaper])

  return (
    <div className="app-shell lite-shell" data-sidebar={collapsed ? 'collapsed' : 'expanded'}>
      <div className="lite-body" inert={settingsOpen ? true : undefined}>
        {collapsed ? null : (
          <PaperSidebar documents={documents} activeDocumentId={split?.focused ? split.documentId : activeDocumentId} splitDocumentId={split ? (split.focused ? activeDocumentId : split.documentId) : null}
            onNew={goHome} onOpen={openPaper} onPrefetch={prefetchPaper} onOpenSettings={openSettings} onOpenInWindow={openInWindow} onOpenInSplit={openSplit} onDeleted={onDeleted} />
        )}
        <main className={`main-surface lite-main${split ? ' reader-split' : ''}`}>
          <div className="lite-pane" style={split ? { flexGrow: split.ratio } : undefined} onPointerDownCapture={() => focusPane(false)} onFocusCapture={() => focusPane(false)}>
          {page.name === 'home' && settings ? (
            <>
              <div className="lite-drag-strip" aria-hidden="true" />
              <NewParsePage settings={settings} onCreated={onImported} onOpenSettings={openSettings} />
            </>
          ) : null}
          {readers.length ? (
            <React.Suspense fallback={activeDocumentId ? <div className="reader-loading"><AppleLoader label="正在開啟論文" /></div> : null}>
              {/* Keyed: each paper keeps its own view state; hidden ones stay mounted but inert and unpainted. */}
              {readers.map((documentId) => (
                <div key={documentId} className="lite-reader-slot" data-active={documentId === activeDocumentId ? 'true' : undefined} inert={documentId === activeDocumentId ? undefined : true}>
                  <KeptReader documentId={documentId} onBack={goHome} onOpenSettings={openSettings} />
                </div>
              ))}
            </React.Suspense>
          ) : null}
          {!settings && page.name === 'home' ? <div className="page-loading"><AppleLoader /></div> : null}
          </div>
          {split ? (
            <>
              <LiteSplitHandle ratio={split.ratio} onRatio={(ratio) => setSplit((current) => current && { ...current, ratio })} />
              <div className="lite-pane" style={{ flexGrow: 1 - split.ratio }} data-split="true" onPointerDownCapture={() => focusPane(true)} onFocusCapture={() => focusPane(true)}>
                <React.Suspense fallback={<div className="reader-loading"><AppleLoader label="正在開啟論文" /></div>}>
                  <ReaderPage key={split.documentId} documentId={split.documentId} showBack={false} resumePosition onBack={closeSplit} onClose={closeSplit} onOpenSettings={openSettings} />
                </React.Suspense>
              </div>
            </>
          ) : null}
        </main>
      </div>
      {settings && settingsOpen ? (
        <React.Suspense fallback={<div className="lite-settings-loading"><AppleLoader label="正在開啟設定" /></div>}>
        <SettingsDialog open={settingsOpen} settings={settings} onSaved={onSettingsSaved} onNavigationGuardChange={onNavigationGuardChange}
          onClose={() => { if (view.name === 'settings') requestViewChange(view.under) }} />
        </React.Suspense>
      ) : null}
      {/* After the page: Chromium applies drag regions in document order, so these must come later to stay clickable. */}
      <div className="edge-dock-persistent"><WindowControls /></div>
      {settingsOpen ? null : (
        <button type="button" className="lite-sidebar-toggle" aria-label={collapsed ? '展開側邊欄' : '收起側邊欄'} aria-expanded={!collapsed} onClick={toggleSidebar}>
          {collapsed ? <MenuUnfoldOutlined aria-hidden="true" /> : <MenuFoldOutlined aria-hidden="true" />}
        </button>
      )}
      {guardDialog}
    </div>
  )
}
