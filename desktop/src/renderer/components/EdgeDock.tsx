import React from 'react'

const HIDE_DELAY_MS = 250

interface EdgeDockProps {
  edge: 'top' | 'bottom'
  label: string
  persistent?: React.ReactNode
  children: React.ReactNode
}

export default function EdgeDock(props: EdgeDockProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const suppressFocusOpen = React.useRef(false)
  const hoverOpened = React.useRef(false)

  const cancelHide = React.useCallback(() => {
    if (hideTimer.current === null) return
    clearTimeout(hideTimer.current)
    hideTimer.current = null
  }, [])

  const show = React.useCallback(() => {
    cancelHide()
    hoverOpened.current = true
    setOpen(true)
  }, [cancelHide])

  const scheduleHide = React.useCallback(() => {
    cancelHide()
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null
      hoverOpened.current = false
      setOpen(false)
    }, HIDE_DELAY_MS)
  }, [cancelHide])

  const handleTriggerClick = React.useCallback(() => {
    if (hoverOpened.current) {
      hoverOpened.current = false
      setOpen(true)
      return
    }
    setOpen((current) => !current)
  }, [])

  const handlePointerLeave = React.useCallback((event: React.PointerEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    scheduleHide()
  }, [scheduleHide])

  React.useEffect(() => cancelHide, [cancelHide])

  const handleBlur = React.useCallback((event: React.FocusEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    scheduleHide()
  }, [scheduleHide])

  const handleEscape = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    cancelHide()
    hoverOpened.current = false
    suppressFocusOpen.current = true
    setOpen(false)
    triggerRef.current?.focus()
    queueMicrotask(() => { suppressFocusOpen.current = false })
  }, [cancelHide])

  return (
    <section
      className={`edge-dock edge-dock-${props.edge}${open ? ' open' : ''}`}
      data-edge-dock={props.edge}
      onPointerEnter={show}
      onPointerLeave={handlePointerLeave}
      onFocusCapture={() => { if (!suppressFocusOpen.current) show() }}
      onBlurCapture={handleBlur}
      onKeyDown={handleEscape}
    >
      {props.edge === 'top' ? <div className="window-drag-region" aria-hidden="true" /> : null}
      {props.persistent ? <div className="edge-dock-persistent">{props.persistent}</div> : null}
      <button
        ref={triggerRef}
        type="button"
        className="edge-dock-trigger"
        aria-label={props.label}
        aria-expanded={open}
        onClick={handleTriggerClick}
      >
        <span aria-hidden="true" />
      </button>
      <div className="edge-dock-panel" aria-hidden={!open} inert={open ? undefined : true} onPointerEnter={show}>
        {props.children}
      </div>
    </section>
  )
}
