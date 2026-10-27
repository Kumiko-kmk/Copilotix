import React from 'react'
import { createPortal } from 'react-dom'

/** `note` items are plain status lines (not clickable); `disabled` items show why they are unavailable. */
export interface BlockMenuItem { key: string; label: string; danger?: boolean; disabled?: boolean; note?: boolean }

/**
 * Right-click menu for reader blocks (PDF boxes, paragraphs, figures). Opened at the pointer by an
 * explicit right click; closed by a choice, Esc, a click elsewhere, scrolling or resizing.
 */
export default function BlockContextMenu(props: { x: number; y: number; items: BlockMenuItem[]; onSelect(key: string): void; onClose(): void }): React.JSX.Element | null {
  const ref = React.useRef<HTMLDivElement>(null)
  const { onClose } = props
  const [position, setPosition] = React.useState({ left: props.x, top: props.y })
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const { width, height } = element.getBoundingClientRect()
    setPosition({ left: Math.max(4, Math.min(props.x, window.innerWidth - width - 4)), top: Math.max(4, Math.min(props.y, window.innerHeight - height - 4)) })
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [props.x, props.y])
  React.useEffect(() => {
    const outside = (event: Event): void => { if (!ref.current?.contains(event.target as Node)) onClose() }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); onClose() } }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('wheel', onClose, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('wheel', onClose, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('keydown', key, true)
    }
  }, [onClose])
  if (!props.items.length) return null
  return createPortal(
    <div ref={ref} className="pdf-block-menu" role="menu" aria-label="段落操作" style={position} onContextMenu={(event) => event.preventDefault()}>
      {props.items.map((item) => item.note
        ? <div key={item.key} className="pdf-block-menu-note" role="none">{item.label}</div>
        : (
          <button key={item.key} type="button" role="menuitem" className={item.danger ? 'danger' : undefined} disabled={item.disabled}
            onClick={() => { onClose(); props.onSelect(item.key) }}>{item.label}</button>
        ))}
    </div>,
    window.document.body
  )
}
