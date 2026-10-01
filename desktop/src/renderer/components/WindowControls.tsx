import React from 'react'
import type { WindowAction } from '@shared/types'

export default function WindowControls(): React.JSX.Element {
  const [maximized, setMaximized] = React.useState(false)

  React.useEffect(() => {
    let active = true
    void window.copilotix.getWindowState()
      .then((state) => { if (active) setMaximized(state.maximized) })
      .catch((error: unknown) => console.error('无法读取窗口状态', error))
    const stop = window.copilotix.onWindowStateChanged((state) => setMaximized(state.maximized))
    return () => {
      active = false
      stop()
    }
  }, [])

  const perform = React.useCallback((action: WindowAction) => {
    void window.copilotix.performWindowAction(action)
      .then((state) => setMaximized(state.maximized))
      .catch((error: unknown) => console.error('窗口操作失败', error))
  }, [])

  return (
    <div className="window-controls" role="group" aria-label="窗口控制">
      <button type="button" className="window-control close" data-window-control="close" aria-label="关闭窗口" onClick={() => perform('close')}>
        <span aria-hidden="true"><svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3L3 9" /></svg></span>
      </button>
      <button type="button" className="window-control minimize" data-window-control="minimize" aria-label="最小化窗口" onClick={() => perform('minimize')}>
        <span aria-hidden="true"><svg viewBox="0 0 12 12"><path d="M2.8 6h6.4" /></svg></span>
      </button>
      <button
        type="button"
        className="window-control maximize"
        data-window-control="toggle-maximize"
        aria-label={maximized ? '还原窗口' : '最大化窗口'}
        aria-pressed={maximized}
        onClick={() => perform('toggle-maximize')}
      >
        <span aria-hidden="true"><svg viewBox="0 0 12 12"><path d={maximized ? 'M5 2.5V5H2.5M7 9.5V7h2.5' : 'M2.5 5V2.5H5M9.5 7v2.5H7'} /></svg></span>
      </button>
    </div>
  )
}
