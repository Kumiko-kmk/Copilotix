import React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileAddOutlined, FileTextOutlined, GithubOutlined, SettingOutlined } from '@ant-design/icons'
import type { AppSettings } from '@shared/types'
import type { DocumentDetails } from '@shared/ipcSchemas'
import EdgeDock from './components/EdgeDock'
import PaperSwitcher from './components/PaperSwitcher'
import WindowControls from './components/WindowControls'
import NewParsePage from './pages/NewParsePage'
import TasksPage from './pages/TasksPage'
import SettingsPage from './pages/SettingsPage'
import {
  applyDocumentChange,
  getDocumentRefreshPlan,
  patchDocumentDetails,
  type DocumentListCache
} from './documentCache'

const ReaderPage = React.lazy(() => import('./pages/ReaderPage'))

type View = { name: 'new' | 'tasks' | 'settings' } | { name: 'reader'; documentId: string }

export default function App(): React.JSX.Element {
  const queryClient = useQueryClient()
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

  const openDocument = React.useCallback((documentId: string) => setView({ name: 'reader', documentId }), [])
  const onSettingsSaved = React.useCallback((next: AppSettings) => {
    queryClient.setQueryData(['settings'], next)
  }, [queryClient])

  return (
    <div className="app-shell">
      {view.name === 'new' ? null : <div className="titlebar-brand" aria-hidden="true">COPILOTIX</div>}
      <EdgeDock edge="top" label="展开主导航" persistent={<WindowControls />}>
        <nav className="top-navigation" aria-label="主导航">
          <NavigationButton active={view.name === 'new'} icon={<FileAddOutlined />} label="新解析" onClick={() => setView({ name: 'new' })} />
          <NavigationButton active={view.name === 'tasks'} icon={<FileTextOutlined />} label="任务管理" onClick={() => setView({ name: 'tasks' })} />
          <NavigationButton active={view.name === 'settings'} icon={<SettingOutlined />} label="设置" onClick={() => setView({ name: 'settings' })} />
          <a className="top-navigation-item" href="https://github.com/Kumiko-kmk/Copilotix" target="_blank" rel="noreferrer" aria-label="打开 GitHub">
            <GithubOutlined /><span>GitHub</span>
          </a>
        </nav>
      </EdgeDock>
      <main className="main-surface">
        {view.name === 'new' && settings ? (
          <NewParsePage
            settings={settings}
            onCreated={() => {
              void queryClient.invalidateQueries({ queryKey: ['documents'] })
              setView({ name: 'tasks' })
            }}
            onOpenSettings={() => setView({ name: 'settings' })}
          />
        ) : null}
        {view.name === 'tasks' ? <TasksPage documents={documents} onOpen={openDocument} /> : null}
        {view.name === 'settings' && settings ? <SettingsPage settings={settings} onSaved={onSettingsSaved} /> : null}
        {view.name === 'reader' ? (
          <React.Suspense fallback={<div className="reader-loading">正在加载阅读器…</div>}>
            <ReaderPage documentId={view.documentId} onBack={() => setView({ name: 'tasks' })} />
          </React.Suspense>
        ) : null}
        {!settings && view.name !== 'reader' ? <div className="page-loading">正在加载…</div> : null}
      </main>
      <EdgeDock edge="bottom" label="展开论文切换">
        <PaperSwitcher documents={documents} activeDocumentId={view.name === 'reader' ? view.documentId : null} onOpen={openDocument} />
      </EdgeDock>
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
