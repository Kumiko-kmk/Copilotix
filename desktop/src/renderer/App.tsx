import React from 'react'
import { DEFAULT_CODEX_SETTINGS } from '@shared/codex'
import { refreshCodexStatus } from './codexStatusClient'
import { loadStorageInfo } from './storageInfoClient'
import { loadReaderPage, loadedReaderPage } from './readerPageLoader'
import { Button, Modal } from 'antd'
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
import type { SettingsNavigationGuard } from './settingsNavigation'

const ReaderPage = React.lazy(loadReaderPage)
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
  const viewRef = React.useRef(view)
  viewRef.current = view
  const settingsGuard = React.useRef<SettingsNavigationGuard | null>(null)
  const [guardBusy, setGuardBusy] = React.useState(false)
  const [pendingView, setPendingView] = React.useState<View | null>(null)
  const [leaving, setLeaving] = React.useState(false)
  const leavingRef = React.useRef(false)
  const onNavigationGuardChange = React.useCallback((guard: SettingsNavigationGuard | null) => {
    settingsGuard.current = guard
    setGuardBusy(Boolean(guard?.busy))
  }, [])
  const requestViewChange = React.useCallback((next: View) => {
    if (leavingRef.current) return
    if (viewRef.current.name === 'settings' && next.name !== 'settings' && (settingsGuard.current?.dirty || settingsGuard.current?.busy)) {
      setPendingView(next)
    } else setView(next)
  }, [])
  const saveAndLeave = async (): Promise<void> => {
    const guard = settingsGuard.current
    if (!pendingView || !guard || guard.busy || leavingRef.current) return
    const destination = pendingView
    leavingRef.current = true
    setLeaving(true)
    try {
      if (await guard.save()) setView(destination)
    } finally {
      setPendingView(null)
      leavingRef.current = false
      setLeaving(false)
    }
  }
  const discardAndLeave = (): void => {
    if (!pendingView || guardBusy || leavingRef.current) return
    settingsGuard.current?.discard()
    setView(pendingView)
    setPendingView(null)
  }
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
  const codexStartupChecked = React.useRef(false)
  React.useEffect(() => {
    if (!settings || codexStartupChecked.current) return
    codexStartupChecked.current = true
    void refreshCodexStatus(settings.codex ?? DEFAULT_CODEX_SETTINGS).catch(() => undefined)
  }, [settings])

  React.useEffect(() => {
    if (!settings?.outputRoot) return
    const preload = (): void => { void loadStorageInfo(settings.outputRoot).catch(() => undefined) }
    preload()
    const timer = setInterval(preload, 60_000)
    return () => clearInterval(timer)
  }, [settings?.outputRoot, documentsQuery.dataUpdatedAt])


  React.useEffect(() => {
    if (!settingsQuery.isSuccess || !documentsQuery.isSuccess || documents.length > 0) return
    const key = 'copilotix:tutorial:seen:v1'
    if (window.localStorage.getItem(key)) return
    window.localStorage.setItem(key, '1')
    requestViewChange({ name: 'tutorial' })
  }, [settingsQuery.isSuccess, documentsQuery.isSuccess, documents.length, requestViewChange])

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
    const stopOpen = window.copilotix.onOpenDocument((documentId) => requestViewChange({ name: 'reader', documentId }))
    return () => {
      stop()
      stopOpen()
    }
  }, [queryClient, requestViewChange])

  // The reader returns to where it was opened from; the home page otherwise.
  const openFromLibrary = React.useCallback((documentId: string) => requestViewChange({ name: 'reader', documentId, returnTo: 'library' }), [requestViewChange])
  const openFromTutorial = React.useCallback((documentId: string) => requestViewChange({ name: 'reader', documentId, returnTo: 'tutorial' }), [requestViewChange])
  const onSettingsSaved = React.useCallback((next: AppSettings) => {
    queryClient.setQueryData(['settings'], next)
  }, [queryClient])
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
          <NewParsePage
            settings={settings}
            documents={documents}
            // New papers join the library, and the home backdrop's titles, as soon as they are listed.
            onCreated={() => void queryClient.invalidateQueries({ queryKey: ['documents'] })}
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
      <Modal title="有未保存的设置" open={pendingView !== null} closable={!leaving} maskClosable={!leaving}
        onCancel={() => { if (!leaving) setPendingView(null) }}
        footer={[
          <Button key="stay" disabled={leaving} onClick={() => setPendingView(null)}>继续编辑</Button>,
          <Button key="discard" disabled={leaving || guardBusy} onClick={discardAndLeave}>放弃并离开</Button>,
          <Button key="save" type="primary" loading={leaving} disabled={guardBusy} onClick={() => void saveAndLeave()}>保存并离开</Button>
        ]}>
        <p>离开前保存修改，或放弃本次未保存的更改。</p>
      </Modal>
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
