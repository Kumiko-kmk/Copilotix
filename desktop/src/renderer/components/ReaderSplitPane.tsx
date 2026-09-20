import React from 'react'

const DEFAULT_LEFT_PERCENT = 100 / 2.05
const MIN_LEFT_PERCENT = 40
const MAX_LEFT_PERCENT = 60
const KEYBOARD_STEP_PERCENT = 2
const STORAGE_KEY = 'copilotix.reader.split-percent'

export default function ReaderSplitPane(props: {
  left: React.ReactNode
  right: React.ReactNode
}): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const draggingRef = React.useRef(false)
  const [leftPercent, setLeftPercent] = React.useState(readStoredPercent)
  const [dragging, setDragging] = React.useState(false)

  const updatePercent = React.useCallback((value: number) => {
    const next = clampSplitPercent(value)
    setLeftPercent(next)
    try {
      window.sessionStorage.setItem(STORAGE_KEY, String(next))
    } catch {
      // Storage may be unavailable in hardened renderer sessions; resizing still works.
    }
  }, [])

  const updateFromPointer = React.useCallback((clientX: number) => {
    const container = containerRef.current
    if (!container) return
    const bounds = container.getBoundingClientRect()
    if (bounds.width <= 0) return
    updatePercent((clientX - bounds.left) / bounds.width * 100)
  }, [updatePercent])

  const finishDrag = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false
    setDragging(false)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const onKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = leftPercent - KEYBOARD_STEP_PERCENT
    else if (event.key === 'ArrowRight') next = leftPercent + KEYBOARD_STEP_PERCENT
    else if (event.key === 'Home') next = MIN_LEFT_PERCENT
    else if (event.key === 'End') next = MAX_LEFT_PERCENT
    if (next === null) return
    event.preventDefault()
    updatePercent(next)
  }, [leftPercent, updatePercent])

  return (
    <div ref={containerRef} className="reader-split" data-dragging={dragging}>
      <div className="reader-split-pane" style={{ flexGrow: leftPercent }}>{props.left}</div>
      <div
        className="reader-split-handle"
        role="separator"
        aria-label="调整 PDF 与 Markdown 阅读器宽度"
        aria-orientation="vertical"
        aria-valuemin={MIN_LEFT_PERCENT}
        aria-valuemax={MAX_LEFT_PERCENT}
        aria-valuenow={Math.round(leftPercent)}
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault()
          event.currentTarget.focus()
          event.currentTarget.setPointerCapture?.(event.pointerId)
          draggingRef.current = true
          setDragging(true)
          updateFromPointer(event.clientX)
        }}
        onPointerMove={(event) => {
          if (draggingRef.current) updateFromPointer(event.clientX)
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={() => {
          draggingRef.current = false
          setDragging(false)
        }}
        onKeyDown={onKeyDown}
      />
      <div className="reader-split-pane" style={{ flexGrow: 100 - leftPercent }}>{props.right}</div>
    </div>
  )
}

export function clampSplitPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LEFT_PERCENT
  return Math.min(MAX_LEFT_PERCENT, Math.max(MIN_LEFT_PERCENT, value))
}

function readStoredPercent(): number {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY)
    if (stored === null || stored.trim() === '') return DEFAULT_LEFT_PERCENT
    const parsed = Number(stored)
    return Number.isFinite(parsed) && parsed >= MIN_LEFT_PERCENT && parsed <= MAX_LEFT_PERCENT
      ? parsed
      : DEFAULT_LEFT_PERCENT
  } catch {
    return DEFAULT_LEFT_PERCENT
  }
}
