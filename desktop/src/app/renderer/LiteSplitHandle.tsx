import React from 'react'

const MIN = 0.25
const MAX = 0.75
const STEP = 0.05

/**
 * The divider between two papers side by side: the reader workbench's own split handle (same look,
 * drag and arrow keys), resizing the left pane's share of the row it sits in.
 */
export default function LiteSplitHandle(props: { ratio: number; onRatio(ratio: number): void }): React.JSX.Element {
  const { onRatio } = props
  const drag = React.useRef<{ left: number; width: number } | null>(null)
  const clamp = (value: number): number => Math.min(MAX, Math.max(MIN, value))
  return (
    <div className="reader-split-handle" role="separator" aria-orientation="vertical" aria-label="調整分屏寬度" tabIndex={0}
      aria-valuemin={MIN * 100} aria-valuemax={MAX * 100} aria-valuenow={Math.round(props.ratio * 100)}
      onPointerDown={(event) => {
        const row = event.currentTarget.parentElement
        if (!row || event.button !== 0) return
        const bounds = row.getBoundingClientRect()
        drag.current = { left: bounds.left, width: bounds.width }
        event.currentTarget.setPointerCapture(event.pointerId)
        row.dataset.dragging = 'true'
      }}
      onPointerMove={(event) => {
        if (drag.current) onRatio(clamp((event.clientX - drag.current.left) / drag.current.width))
      }}
      onPointerUp={(event) => {
        drag.current = null
        delete event.currentTarget.parentElement?.dataset.dragging
      }}
      onLostPointerCapture={(event) => {
        drag.current = null
        delete event.currentTarget.parentElement?.dataset.dragging
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          onRatio(clamp(props.ratio + (event.key === 'ArrowLeft' ? -STEP : STEP)))
        }
      }} />
  )
}
