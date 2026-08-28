import React from 'react'
import { FileAddOutlined, FileTextOutlined, GithubOutlined, SettingOutlined } from '@ant-design/icons'
import type { AppSettings, MinerUTask } from '@shared/types'
import logoUrl from '../../resources/icon.png'
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
      <aside className="sidebar" aria-label="主导航">
        <button className="brand" onClick={() => setView({ name: 'new' })} aria-label="MinerU 首页">
          <img src={logoUrl} alt="" />
          <span>MinerU</span>
        </button>
        <nav className="primary-nav">
          <NavButton active={view.name === 'new'} icon={<FileAddOutlined />} label="新解析" onClick={() => setView({ name: 'new' })} />
          <NavButton active={view.name === 'tasks'} icon={<FileTextOutlined />} label="任务管理" onClick={() => setView({ name: 'tasks' })} />
        </nav>
        <div className="recent-section">
          <div className="recent-title">最近任务</div>
          {tasks.slice(0, 5).map((task) => (
            <button key={task.id} className="recent-task" onClick={() => openTask(task.id)} title={task.name}>
              <span className="pdf-dot">PDF</span>
              <span>
                <strong>{task.name}</strong>
                <small>{task.status === 'completed' ? '已完成' : `${task.progress}%`}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="sidebar-footer">
          <a href="https://github.com/Kumiko-kmk/MinerU" aria-label="GitHub" tabIndex={-1}><GithubOutlined /></a>
          <button className={view.name === 'settings' ? 'active' : ''} onClick={() => setView({ name: 'settings' })} aria-label="设置">
            <SettingOutlined />
          </button>
        </div>
      </aside>
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
    </div>
  )
}

function NavButton(props: {
  active: boolean
  icon: React.ReactNode
  label: string
  onClick(): void
}): React.JSX.Element {
  return (
    <button className={props.active ? 'nav-button active' : 'nav-button'} onClick={props.onClick}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  )
}
