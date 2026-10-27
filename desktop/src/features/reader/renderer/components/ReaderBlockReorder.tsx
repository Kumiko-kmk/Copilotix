import React from 'react'
import { createPortal } from 'react-dom'

/** Reordering of whole content blocks; the order is kept in the user's edit layer. */
export interface ReaderBlockMove {
  /** Moves content positions in front of another block's position, or to the end. */
  move(unit: number[], before: number | null): void
  reset(): void
  /** The paper is shown in a reading order the user set. */
  ordered: boolean
}

/** A press held this long without moving picks up the block; moving earlier selects text as usual. */
export const REORDER_HOLD_MS = 400
const SLOP = 4
const EDGE = 48
const IGNORE = 'a, button, input, textarea, select, [contenteditable="true"], .reader-block-editor, .pdf-block-menu'

interface Unit { blocks: number[]; elements: HTMLElement[] }
interface Drag { unit: number[]; source: HTMLElement[]; x: number; y: number; before: number | null | undefined }

/**
 * Long-press drag of a paragraph or a whole figure (images with their caption) in a reading view.
 * While dragging, text selection is off, the picked block is faded and a line marks where it lands;
 * Esc cancels. The click that ends the drag does not select or edit the block below.
 */
export function useBlockReorder(options: {
  container: React.RefObject<HTMLDivElement | null>
  article: React.RefObject<HTMLElement | null>
  enabled: boolean
  /** Visible block indexes that move together with this block; null when it does not move. */
  unitOf(blockIndex: number): number[] | null
  contentIndexOf(blockIndex: number): number | undefined
  onMove(unit: number[], before: number | null): void
}): React.ReactNode {
  const latest = React.useRef(options)
  latest.current = options
  const [line, setLine] = React.useState<{ top: number; left: number; width: number } | null>(null)
  const article = options.article.current
  React.useEffect(() => {
    const root = options.article.current
    if (!options.enabled || !root) return
    let timer: number | null = null
    let start: { x: number; y: number; index: number; pointerId: number } | null = null
    let drag: Drag | null = null
    let frame: number | null = null

    const units = (): Unit[] => {
      const result: Unit[] = []
      const seen = new Set<number>()
      for (const element of root.querySelectorAll<HTMLElement>('.markdown-block[data-reader-role="content"]')) {
        const index = Number(element.dataset.readerBlockIndex)
        if (!Number.isInteger(index) || seen.has(index)) continue
        const blocks = latest.current.unitOf(index) ?? [index]
        blocks.forEach(block => seen.add(block))
        const elements = blocks.flatMap(block => [...root.querySelectorAll<HTMLElement>(`.markdown-block[data-reader-block-index="${block}"]`)])
        result.push({ blocks, elements: elements.length ? elements : [element] })
      }
      return result
    }
    const target = (): void => {
      if (!drag) return
      const list = units()
      const from = list.findIndex(unit => unit.blocks.includes(drag!.unit[0]!))
      let best: { distance: number; gap: number; y: number } | null = null
      for (let gap = 0; gap <= list.length; gap += 1) {
        if (gap === from || gap === from + 1) continue
        const y = gap < list.length ? list[gap]!.elements[0]!.getBoundingClientRect().top : list[gap - 1]!.elements.at(-1)!.getBoundingClientRect().bottom
        const distance = Math.abs(drag.y - y)
        if (!best || distance < best.distance) best = { distance, gap, y }
      }
      const box = root.getBoundingClientRect()
      if (!best) { drag.before = undefined; setLine(null); return }
      drag.before = best.gap < list.length ? latest.current.contentIndexOf(list[best.gap]!.blocks[0]!) ?? undefined : null
      setLine({ top: best.y, left: box.left, width: box.width })
    }
    const scroll = (): void => {
      frame = null
      const container = latest.current.container.current
      if (!drag || !container) return
      const box = container.getBoundingClientRect()
      // Faster the closer the pointer is to the edge, so a drop just inside the view is not carried away.
      const depth = drag.y < box.top + EDGE ? drag.y - (box.top + EDGE) : drag.y > box.bottom - EDGE ? drag.y - (box.bottom - EDGE) : 0
      const step = Math.round(Math.max(-1, Math.min(1, depth / EDGE)) * 14)
      if (step) { container.scrollTop += step; target(); frame = window.requestAnimationFrame(scroll) }
    }
    const stop = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      if (frame !== null) window.cancelAnimationFrame(frame)
      timer = frame = null
      start = null
      if (drag) for (const element of drag.source) delete element.dataset.reorderSource
      latest.current.container.current?.classList.remove('markdown-reordering')
      drag = null
      setLine(null)
    }
    const swallowClick = (): void => {
      const swallow = (event: MouseEvent): void => { event.preventDefault(); event.stopPropagation() }
      window.addEventListener('click', swallow, { capture: true, once: true })
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
    }
    const pick = (): void => {
      timer = null
      if (!start) return
      const unit = latest.current.unitOf(start.index)
      if (!unit) { start = null; return }
      window.getSelection()?.removeAllRanges()
      const source = unit.flatMap(block => [...root.querySelectorAll<HTMLElement>(`.markdown-block[data-reader-block-index="${block}"]`)])
      for (const element of source) element.dataset.reorderSource = ''
      latest.current.container.current?.classList.add('markdown-reordering')
      drag = { unit, source, x: start.x, y: start.y, before: undefined }
      target()
    }
    const down = (event: PointerEvent): void => {
      if (event.button !== 0 || event.pointerType === 'touch' || drag) return
      const element = event.target instanceof Element ? event.target : null
      if (!element || element.closest(IGNORE)) return
      const block = element.closest<HTMLElement>('.markdown-block[data-reader-role="content"]')
      const index = Number(block?.dataset.readerBlockIndex)
      if (!block || !Number.isInteger(index) || block.dataset.editing) return
      start = { x: event.clientX, y: event.clientY, index, pointerId: event.pointerId }
      timer = window.setTimeout(pick, REORDER_HOLD_MS)
    }
    const move = (event: PointerEvent): void => {
      if (drag) {
        drag.x = event.clientX
        drag.y = event.clientY
        window.getSelection()?.removeAllRanges()
        target()
        if (frame === null) frame = window.requestAnimationFrame(scroll)
      } else if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > SLOP) {
        if (timer !== null) window.clearTimeout(timer)
        timer = null
        start = null
      }
    }
    const up = (): void => {
      if (drag) {
        const { unit, before } = drag
        const units = unit.flatMap(block => { const index = latest.current.contentIndexOf(block); return index === undefined ? [] : [index] })
        swallowClick()
        stop()
        if (before !== undefined && units.length) latest.current.onMove(units, before)
        return
      }
      stop()
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); swallowClick(); stop() }
    }
    const selectStart = (event: Event): void => { if (drag) event.preventDefault() }
    root.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('blur', stop)
    window.addEventListener('keydown', key, true)
    document.addEventListener('selectstart', selectStart)
    return () => {
      stop()
      root.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('blur', stop)
      window.removeEventListener('keydown', key, true)
      document.removeEventListener('selectstart', selectStart)
    }
  }, [options.enabled, options.article, article])
  return line ? createPortal(<div className="markdown-reorder-indicator" aria-hidden="true" style={{ top: line.top - 1, left: line.left, width: line.width }} />, document.body) : null
}
