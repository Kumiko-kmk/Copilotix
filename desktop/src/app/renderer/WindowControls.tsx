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

  // Expose window state to CSS: maximized windows lose their rounded corners and an
  // unfocused window greys out its traffic lights, matching macOS behaviour.
  React.useEffect(() => {
    document.documentElement.dataset.windowMaximized = String(maximized)
  }, [maximized])

  React.useEffect(() => {
    const root = document.documentElement
    const sync = (): void => { root.dataset.windowFocused = String(document.hasFocus()) }
    sync()
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      delete root.dataset.windowFocused
      delete root.dataset.windowMaximized
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
        <span aria-hidden="true"><svg viewBox="0 0 12 12"><path className="filled" d={maximized ? 'M5.6 2.6v3H2.6ZM6.4 9.4v-3h3Z' : 'M3 3h3.8L3 6.8ZM9 9H5.2L9 5.2Z'} /></svg></span>
      </button>
    </div>
  )
}
