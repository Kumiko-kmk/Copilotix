import React from 'react'
import { SettingsPage } from '@features/settings/renderer'
// Direct import: the reader barrel re-exports Markdown rendering (KaTeX CSS) that must stay in the lazy reader chunk.
import { loadReaderPage, loadedReaderPage } from '@features/reader/renderer/readerPageLoader'
import { useQueryClient } from '@tanstack/react-query'
import { AppstoreOutlined, FileAddOutlined, GithubOutlined, ReadOutlined, SettingOutlined } from '@ant-design/icons'
import type { DocumentSummary } from '@features/library/contract/documentSchemas'
import EdgeDock from './EdgeDock'
import WindowControls from './WindowControls'
import { useAppData } from './useAppData'
import { useGuardedViews } from './useGuardedViews'
import { DecoratedHomePage, TutorialPage, type DocumentListCache, loadLibraryCategories, requestLibraryFocus, ACTIVE_STATUSES } from '@features/library/renderer'

const ReaderPage = React.lazy(loadReaderPage)
// Three.js is only loaded once the archive is opened.
const LibraryPage = React.lazy(() => import('@features/library/renderer/LibraryPage'))

type ReaderOrigin = 'new' | 'library' | 'tutorial'
type View = { name: ReaderOrigin | 'settings' } | { name: 'reader'; documentId: string; returnTo?: ReaderOrigin }

export default function App(): React.JSX.Element {
  const queryClient = useQueryClient()
  const insights = React.useMemo<import('@features/insight/contract/paperInsight').PaperInsightSource>(() => ({
    get: (documentId) => window.copilotix.paperInsight.get({ documentId }),
    readSaved: (documentId) => window.copilotix.paperInsight.get({ documentId, savedOnly: true }),
    ...(window.copilotix.paperInsight.list ? { list: (documentIds: readonly string[]) => window.copilotix.paperInsight.list!({ documentIds }) } : {}),
    cancel: (documentId) => window.copilotix.paperInsight.cancel({ documentId }),
    generate: (documentId) => window.copilotix.paperInsight.generate({ documentId }),
    subscribe: (listener) => window.copilotix.paperInsight.onChanged(({ documentId, state }) => listener(documentId, state))
  }), [])
  const { view, requestViewChange, onNavigationGuardChange, guardDialog } = useGuardedViews<View>({ name: 'new' })
  const { settingsQuery, documentsQuery, settings, documents, mergeImported, onSettingsSaved } = useAppData()
  // The home progress card: papers imported in this session plus any still processing, until dismissed.
  const [recentImportIds, setRecentImportIds] = React.useState<readonly string[]>([])
  const [dismissedProgressIds, setDismissedProgressIds] = React.useState<ReadonlySet<string>>(() => new Set())
  const progressDocuments = React.useMemo(() => documents.filter((document) =>
    !dismissedProgressIds.has(document.id) && (recentImportIds.includes(document.id) || ACTIVE_STATUSES.has(document.workflow.status))
  ), [documents, recentImportIds, dismissedProgressIds])
  const onImported = React.useCallback((created: DocumentSummary[]) => {
    const ids = new Set(created.map((document) => document.id))
    mergeImported(created)
    setRecentImportIds((current) => [...ids, ...current.filter((id) => !ids.has(id))])
  }, [mergeImported])

  React.useEffect(() => {
    if (!settingsQuery.isSuccess || !documentsQuery.isSuccess || documents.length > 0) return
    const key = 'copilotix:tutorial:seen:v1'
    if (window.localStorage.getItem(key)) return
    window.localStorage.setItem(key, '1')
    requestViewChange({ name: 'tutorial' })
  }, [settingsQuery.isSuccess, documentsQuery.isSuccess, documents.length, requestViewChange])

  React.useEffect(() => window.copilotix.onOpenDocument((documentId) => requestViewChange({ name: 'reader', documentId })), [requestViewChange])

  // The reader returns to where it was opened from; the home page otherwise.
  const openFromLibrary = React.useCallback((documentId: string) => requestViewChange({ name: 'reader', documentId, returnTo: 'library' }), [requestViewChange])
  const openFromTutorial = React.useCallback((documentId: string) => requestViewChange({ name: 'reader', documentId, returnTo: 'tutorial' }), [requestViewChange])
  const ActiveReaderPage = view.name === 'reader' && view.returnTo === 'library' ? loadedReaderPage() ?? ReaderPage : ReaderPage

  return (
    <div className="app-shell">
      {view.name === 'new' ? null : <div className="titlebar-brand" aria-hidden="true">COPILOTIX</div>}
      <EdgeDock label="展开主导航" persistent={<WindowControls />}>
        <nav className="top-navigation" aria-label="主导航">
          <NavigationButton active={view.name === 'new'} icon={<FileAddOutlined />} label="新解析" onClick={() => requestViewChange({ name: 'new' })} />
          <NavigationButton active={view.name === 'library'} icon={<AppstoreOutlined />} label="文库" onClick={() => requestViewChange({ name: 'library' })} />
          <NavigationButton active={view.name === 'settings'} icon={<SettingOutlined />} label="设置" onClick={() => requestViewChange({ name: 'settings' })} />
          <NavigationButton active={view.name === 'tutorial'} icon={<ReadOutlined />} label="新手教程" onClick={() => requestViewChange({ name: 'tutorial' })} />
          <a className="top-navigation-item" href="https://github.com/Kumiko-kmk/Copilotix" target="_blank" rel="noreferrer" aria-label="打开 GitHub">
            <GithubOutlined /><span>GitHub</span>
          </a>
        </nav>
      </EdgeDock>
      <main className="main-surface">
        {view.name === 'new' && settings ? (
          <DecoratedHomePage
            settings={settings}
            documents={documents}
            progressDocuments={progressDocuments}
            onCreated={onImported}
            onOpenReader={(documentId) => requestViewChange({ name: 'reader', documentId, returnTo: 'new' })}
            onShowInLibrary={(documentId) => {
              requestLibraryFocus(documentId)
              requestViewChange({ name: 'library' })
            }}
            onDismissProgress={(documentId) => setDismissedProgressIds((current) => new Set([...current, documentId]))}
            onOpenSettings={() => requestViewChange({ name: 'settings' })}
            onOpenTutorial={() => requestViewChange({ name: 'tutorial' })}
          />
        ) : null}
        {view.name === 'library' ? (
          <React.Suspense fallback={<div className="page-loading">正在加载文库…</div>}>
            <LibraryPage insights={insights} loadCategories={loadLibraryCategories} documents={documents} onOpen={openFromLibrary} onCreate={() => requestViewChange({ name: 'new' })} />
          </React.Suspense>
        ) : null}
        {view.name === 'tutorial' && settings ? <TutorialPage
          settings={settings}
          documents={documents}
          onSettingsSaved={onSettingsSaved}
          onOpenReader={openFromTutorial}
          onImported={(document) => {
            queryClient.setQueryData<DocumentListCache>(['documents'], (current) => ({
              sessionId: current?.sessionId,
              revision: current?.revision ?? 0,
              documents: [document, ...(current?.documents ?? []).filter((item) => item.id !== document.id)]
            }))
          }}
          onClose={() => requestViewChange({ name: 'new' })}
        /> : null}
        {view.name === 'settings' && settings ? <SettingsPage settings={settings} onSaved={onSettingsSaved} onNavigationGuardChange={onNavigationGuardChange} /> : null}
        {view.name === 'reader' ? (
          <React.Suspense fallback={<div className="reader-loading">正在加载阅读器…</div>}>
            <ActiveReaderPage documentId={view.documentId} enterFromLibrary={view.returnTo === 'library'} insights={insights} onBack={() => requestViewChange({ name: view.returnTo ?? 'new' })} onOpenSettings={() => requestViewChange({ name: 'settings' })} />
          </React.Suspense>
        ) : null}
        {!settings && view.name !== 'reader' && view.name !== 'library' ? <div className="page-loading">正在加载…</div> : null}
      </main>
      {guardDialog}
    </div>
  )
}

function NavigationButton(props: {
  active: boolean
  icon: React.ReactNode
  label: string
  onClick(): void
}): React.JSX.Element {
  return (
    <button type="button" className={props.active ? 'top-navigation-item active' : 'top-navigation-item'} aria-current={props.active ? 'page' : undefined} onClick={props.onClick}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  )
}
