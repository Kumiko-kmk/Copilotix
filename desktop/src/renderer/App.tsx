import React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AppstoreOutlined, FileAddOutlined, GithubOutlined, ReadOutlined, SettingOutlined } from '@ant-design/icons'
import type { AppSettings } from '@shared/types'
import type { DocumentDetails } from '@shared/ipcSchemas'
import EdgeDock from './components/EdgeDock'
import WindowControls from './components/WindowControls'
import NewParsePage from './pages/NewParsePage'
import SettingsPage from './pages/SettingsPage'
import TutorialPage from './pages/TutorialPage'
import {
  applyDocumentChange,
  getDocumentRefreshPlan,
  patchDocumentDetails,
  type DocumentListCache
} from './documentCache'
import { loadLibraryCategories } from './paperArchive/libraryCategoriesClient'

const ReaderPage = React.lazy(() => import('./pages/ReaderPage'))
// Three.js is only loaded once the archive is opened.
const LibraryPage = React.lazy(() => import('./pages/LibraryPage'))

type ReaderOrigin = 'new' | 'library' | 'tutorial'
type View = { name: ReaderOrigin | 'settings' } | { name: 'reader'; documentId: string; returnTo?: ReaderOrigin }

export default function App(): React.JSX.Element {
  const queryClient = useQueryClient()
  const insights = React.useMemo<import('@shared/paperInsight').PaperInsightSource>(() => ({
    get: (documentId) => window.copilotix.paperInsight.get({ documentId }),
    cancel: (documentId) => window.copilotix.paperInsight.cancel({ documentId }),
    generate: (documentId) => window.copilotix.paperInsight.generate({ documentId }),
    subscribe: (listener) => window.copilotix.paperInsight.onChanged(({ documentId, state }) => listener(documentId, state))
  }), [])
  const [view, setView] = React.useState<View>({ name: 'new' })
  const settingsQuery = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: () => window.copilotix.getSettings()
  })
  const documentsQuery = useQuery<DocumentListCache>({
    queryKey: ['documents'],
    queryFn: async () => ({ revision: 0, documents: await window.copilotix.listDocuments() })
  })
  const settings = settingsQuery.data
  const documents = documentsQuery.data?.documents ?? []

  React.useEffect(() => {
    if (!settingsQuery.isSuccess || !documentsQuery.isSuccess || documents.length > 0) return
    const key = 'copilotix:tutorial:seen:v1'
    if (window.localStorage.getItem(key)) return
    window.localStorage.setItem(key, '1')
    setView({ name: 'tutorial' })
  }, [settingsQuery.isSuccess, documentsQuery.isSuccess, documents.length])

  React.useEffect(() => {
    const stop = window.copilotix.onDocumentsChanged((change) => {
      const current = queryClient.getQueryData<DocumentListCache>(['documents'])
      const previousSummaries = new Map(current?.documents.map((document) => [document.id, document] as const))
      if (!current) {
        void queryClient.invalidateQueries({ queryKey: ['documents'] })
      } else {
        queryClient.setQueryData(['documents'], applyDocumentChange(current, change))
      }

      for (const summary of change.upserted) {
        const refreshPlan = getDocumentRefreshPlan(previousSummaries.get(summary.id), summary)
        queryClient.setQueryData<DocumentDetails>(['document', summary.id], (detail) =>
          patchDocumentDetails(detail, change)
        )
        if (refreshPlan.invalidateDocument) {
          void queryClient.invalidateQueries({ queryKey: ['document', summary.id] })
        }
        for (const view of refreshPlan.annotationViews) {
          void queryClient.invalidateQueries({ queryKey: ['annotations', summary.id, view] })
        }
      }
      for (const documentId of change.removedIds) {
        queryClient.removeQueries({ queryKey: ['document', documentId] })
        queryClient.removeQueries({ queryKey: ['annotations', documentId] })
      }
    })
    const stopOpen = window.copilotix.onOpenDocument((documentId) => setView({ name: 'reader', documentId }))
    return () => {
      stop()
      stopOpen()
    }
  }, [queryClient])

  // The reader returns to where it was opened from; the home page otherwise.
  const openDocument = React.useCallback((documentId: string) => setView({ name: 'reader', documentId }), [])
  const openFromLibrary = React.useCallback((documentId: string) => setView({ name: 'reader', documentId, returnTo: 'library' }), [])
  const openFromTutorial = React.useCallback((documentId: string) => setView({ name: 'reader', documentId, returnTo: 'tutorial' }), [])
  const onSettingsSaved = React.useCallback((next: AppSettings) => {
    queryClient.setQueryData(['settings'], next)
  }, [queryClient])

  return (
    <div className="app-shell">
      {view.name === 'new' ? null : <div className="titlebar-brand" aria-hidden="true">COPILOTIX</div>}
      <EdgeDock label="展开主导航" persistent={<WindowControls />}>
        <nav className="top-navigation" aria-label="主导航">
          <NavigationButton active={view.name === 'new'} icon={<FileAddOutlined />} label="新解析" onClick={() => setView({ name: 'new' })} />
          <NavigationButton active={view.name === 'library'} icon={<AppstoreOutlined />} label="文库" onClick={() => setView({ name: 'library' })} />
          <NavigationButton active={view.name === 'settings'} icon={<SettingOutlined />} label="设置" onClick={() => setView({ name: 'settings' })} />
          <NavigationButton active={view.name === 'tutorial'} icon={<ReadOutlined />} label="新手教程" onClick={() => setView({ name: 'tutorial' })} />
          <a className="top-navigation-item" href="https://github.com/Kumiko-kmk/Copilotix" target="_blank" rel="noreferrer" aria-label="打开 GitHub">
            <GithubOutlined /><span>GitHub</span>
          </a>
        </nav>
      </EdgeDock>
      <main className="main-surface">
        {view.name === 'new' && settings ? (
          <NewParsePage
            settings={settings}
            documents={documents}
            onOpenDocument={openDocument}
            onOpenLibrary={() => setView({ name: 'library' })}
            // New papers appear at the head of "继续阅读" with their progress.
            onCreated={() => void queryClient.invalidateQueries({ queryKey: ['documents'] })}
            onOpenSettings={() => setView({ name: 'settings' })}
            onOpenTutorial={() => setView({ name: 'tutorial' })}
          />
        ) : null}
        {view.name === 'library' ? (
          <React.Suspense fallback={<div className="page-loading">正在加载文库…</div>}>
            <LibraryPage insights={insights} loadCategories={loadLibraryCategories} documents={documents} onOpen={openFromLibrary} onCreate={() => setView({ name: 'new' })} />
          </React.Suspense>
        ) : null}
        {view.name === 'tutorial' && settings ? <TutorialPage
          settings={settings}
          documents={documents}
          onSettingsSaved={onSettingsSaved}
          onOpenReader={openFromTutorial}
          onImported={(document) => {
            queryClient.setQueryData<DocumentListCache>(['documents'], (current) => ({
              revision: current?.revision ?? 0,
              documents: [document, ...(current?.documents ?? []).filter((item) => item.id !== document.id)]
            }))
          }}
          onClose={() => setView({ name: 'new' })}
        /> : null}
        {view.name === 'settings' && settings ? <SettingsPage settings={settings} onSaved={onSettingsSaved} /> : null}
        {view.name === 'reader' ? (
          <React.Suspense fallback={<div className="reader-loading">正在加载阅读器…</div>}>
            <ReaderPage documentId={view.documentId} onBack={() => setView({ name: view.returnTo ?? 'new' })} onOpenSettings={() => setView({ name: 'settings' })} />
          </React.Suspense>
        ) : null}
        {!settings && view.name !== 'reader' && view.name !== 'library' ? <div className="page-loading">正在加载…</div> : null}
      </main>
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
