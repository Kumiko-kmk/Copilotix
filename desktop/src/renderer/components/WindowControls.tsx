import React from 'react'
import type { WindowAction } from '@shared/types'

export default function WindowControls(): React.JSX.Element {
  const [maximized, setMaximized] = React.useState(false)

  React.useEffect(() => {
    let active = true
    void window.mineru.getWindowState()
      .then((state) => { if (active) setMaximized(state.maximized) })
      .catch((error: unknown) => console.error('无法读取窗口状态', error))
    const stop = window.mineru.onWindowStateChanged((state) => setMaximized(state.maximized))
    return () => {
      active = false
      stop()
    }
  }, [])

  const perform = React.useCallback((action: WindowAction) => {
    void window.mineru.performWindowAction(action)
      .then((state) => setMaximized(state.maximized))
      .catch((error: unknown) => console.error('窗口操作失败', error))
  }, [])

  return (
    <div className="window-controls" role="group" aria-label="窗口控制">
      <button type="button" className="window-control close" data-window-control="close" aria-label="关闭窗口" onClick={() => perform('close')}>
        <span aria-hidden="true">×</span>
      </button>
      <button type="button" className="window-control minimize" data-window-control="minimize" aria-label="最小化窗口" onClick={() => perform('minimize')}>
        <span aria-hidden="true">−</span>
      </button>
      <button
        type="button"
        className="window-control maximize"
        data-window-control="toggle-maximize"
        aria-label={maximized ? '还原窗口' : '最大化窗口'}
        aria-pressed={maximized}
        onClick={() => perform('toggle-maximize')}
      >
        <span aria-hidden="true">{maximized ? '↙' : '↗'}</span>
      </button>
    </div>
  )
}
