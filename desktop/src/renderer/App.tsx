import React from 'react'
import { FileAddOutlined, FileTextOutlined, GithubOutlined, SettingOutlined } from '@ant-design/icons'
import type { AppSettings, MinerUTask } from '@shared/types'
import EdgeDock from './components/EdgeDock'
import PaperSwitcher from './components/PaperSwitcher'
import WindowControls from './components/WindowControls'
import NewParsePage from './pages/NewParsePage'
import TasksPage from './pages/TasksPage'
import SettingsPage from './pages/SettingsPage'

const ReaderPage = React.lazy(() => import('./pages/ReaderPage'))

type View = { name: 'new' | 'tasks' | 'settings' } | { name: 'reader'; taskId: string }

export default function App(): React.JSX.Element {
  const [view, setView] = React.useState<View>({ name: 'new' })
  const [tasks, setTasks] = React.useState<MinerUTask[]>([])
  const [settings, setSettings] = React.useState<AppSettings | null>(null)

  const refresh = React.useCallback(async () => {
    const [nextTasks, nextSettings] = await Promise.all([window.mineru.listTasks(), window.mineru.getSettings()])
    setTasks(nextTasks)
    setSettings(nextSettings)
  }, [])

  React.useEffect(() => {
    void refresh()
    const stopTasks = window.mineru.onTasksChanged(setTasks)
    const stopOpen = window.mineru.onOpenTask((taskId) => setView({ name: 'reader', taskId }))
    return () => {
      stopTasks()
      stopOpen()
    }
  }, [refresh])

  const openTask = React.useCallback((taskId: string) => setView({ name: 'reader', taskId }), [])

  return (
    <div className="app-shell">
      <EdgeDock edge="top" label="展开主导航" persistent={<WindowControls />}>
        <nav className="top-navigation" aria-label="主导航">
          <NavigationButton active={view.name === 'new'} icon={<FileAddOutlined />} label="新解析" onClick={() => setView({ name: 'new' })} />
          <NavigationButton active={view.name === 'tasks'} icon={<FileTextOutlined />} label="任务管理" onClick={() => setView({ name: 'tasks' })} />
          <NavigationButton active={view.name === 'settings'} icon={<SettingOutlined />} label="设置" onClick={() => setView({ name: 'settings' })} />
          <a className="top-navigation-item" href="https://github.com/Kumiko-kmk/MinerU" target="_blank" rel="noreferrer" aria-label="打开 GitHub">
            <GithubOutlined /><span>GitHub</span>
          </a>
        </nav>
      </EdgeDock>
      <main className="main-surface">
        {view.name === 'new' && settings ? (
          <NewParsePage
            settings={settings}
            onCreated={() => setView({ name: 'tasks' })}
            onOpenSettings={() => setView({ name: 'settings' })}
          />
        ) : null}
        {view.name === 'tasks' ? <TasksPage tasks={tasks} onOpen={openTask} /> : null}
        {view.name === 'settings' && settings ? (
          <SettingsPage settings={settings} onSaved={(next) => setSettings(next)} />
        ) : null}
        {view.name === 'reader' ? (
          <React.Suspense fallback={<div className="reader-loading">正在加载阅读器…</div>}>
            <ReaderPage taskId={view.taskId} onBack={() => setView({ name: 'tasks' })} />
          </React.Suspense>
        ) : null}
        {!settings && view.name !== 'reader' ? <div className="page-loading">正在加载…</div> : null}
      </main>
      <EdgeDock edge="bottom" label="展开论文切换">
        <PaperSwitcher tasks={tasks} activeTaskId={view.name === 'reader' ? view.taskId : null} onOpen={openTask} />
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
