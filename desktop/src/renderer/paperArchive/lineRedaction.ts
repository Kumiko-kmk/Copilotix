import React from 'react'
import { REDACTION_SECONDS, redactionOffset } from './archiveDecryption'

// Line-by-line redaction after RhineLabUI's document-decryption.ts (MIT, LBEILC): every rendered
// line of the marked fields gets its own ink bar, measured from the text without splitting or
// replacing it, and the bars slide out to the right in reading order once the glass clears.

const TARGETS = '.paper-archive-reveal'
const SAMPLES = 24

interface Line { x: number; y: number; right: number; bottom: number }

/**
 * Covers every line inside `.paper-archive-reveal` elements of `root` with an ink bar drawn into
 * `layer` until `reveal` turns true. `content` re-measures while still covered (text that loads
 * late is covered too); text that arrives after the reveal simply appears.
 */
export function useLineRedaction(
  root: React.RefObject<HTMLElement | null>,
  layer: React.RefObject<HTMLElement | null>,
  options: { covered: boolean; reveal: boolean; content: unknown }
): void {
  const revealedRef = React.useRef(false)
  const { covered, reveal, content } = options

  React.useLayoutEffect(() => {
    const host = layer.current
    const article = root.current
    if (!host || !article) return
    if (!covered || reveal) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    revealedRef.current = false
    // No cleanup: the bars must survive the render in which `reveal` turns true, and they are
    // replaced on the next measurement or removed with the panel.
    drawCovers(article, host)
    // While covered the text itself is not painted: the panel fades in, and half-transparent bars
    // over half-transparent text showed the text before the covers looked solid.
    article.dataset.redacted = ''
    // Keep the bars aligned when the viewport, fonts, scroll position or the text itself change
    // while covered: a field that loads late moves everything below it.
    let active = true
    const redraw = (): void => { if (active) drawCovers(article, host) }
    const stop = watchLayout(article, host, redraw)
    void document.fonts?.ready.then(redraw)
    return () => {
      active = false
      stop()
    }
  }, [root, layer, covered, reveal, content])

  React.useLayoutEffect(() => {
    const host = layer.current
    if (!host || !reveal || revealedRef.current) return
    revealedRef.current = true
    // The bars are solid now and still in place: the text can be painted beneath them.
    if (root.current) delete root.current.dataset.redacted
    const inks = [...host.querySelectorAll<HTMLElement>('.paper-archive-redaction-ink')]
    if (!inks.length || typeof inks[0]!.animate !== 'function') {
      host.replaceChildren()
      return
    }
    const article = root.current
    const animations = inks.map((ink, order) => ink.animate(
      Array.from({ length: SAMPLES + 1 }, (_, step) => ({
        transform: `translateX(${(redactionOffset(step / SAMPLES, order, inks.length) * 101).toFixed(2)}%)`
      })),
      { duration: REDACTION_SECONDS * 1000, easing: 'linear', fill: 'forwards' }
    ))
    // Bars measured for the old layout must not cover the wrong text while they slide away.
    const stop = article ? watchLayout(article, host, () => {
      animations.forEach((animation) => animation.cancel())
      host.replaceChildren()
    }) : () => undefined
    void Promise.all(animations.map((animation) => animation.finished)).then(() => host.replaceChildren(), () => undefined).finally(stop)
    return () => {
      stop()
      animations.forEach((animation) => animation.cancel())
    }
  }, [root, layer, reveal])
}

/** Calls `changed` when the panel resizes, scrolls or its text changes (ignoring the bar layer). */
function watchLayout(article: HTMLElement, host: HTMLElement, changed: () => void): () => void {
  let frame = 0
  const schedule = (): void => {
    if (frame) return
    frame = requestAnimationFrame(() => { frame = 0; changed() })
  }
  // A ResizeObserver reports every element once as soon as it is observed. That first report is
  // not a change: treating it as one cancelled the bars two frames into their slide.
  const sizes = new Map<Element, string>()
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
    let moved = false
    for (const entry of entries) {
      const size = `${entry.contentRect.width}x${entry.contentRect.height}`
      if (sizes.has(entry.target) && sizes.get(entry.target) !== size) moved = true
      sizes.set(entry.target, size)
    }
    if (moved) schedule()
  })
  resize?.observe(article)
  article.querySelectorAll<HTMLElement>(TARGETS).forEach((target) => resize?.observe(target))
  const mutation = typeof MutationObserver === 'undefined' ? null : new MutationObserver((records) => {
    if (records.some((record) => !host.contains(record.target))) schedule()
  })
  mutation?.observe(article, { childList: true, subtree: true, characterData: true })
  article.addEventListener('scroll', schedule, true)
  return () => {
    cancelAnimationFrame(frame)
    resize?.disconnect()
    mutation?.disconnect()
    article.removeEventListener('scroll', schedule, true)
  }
}

function drawCovers(article: HTMLElement, host: HTMLElement): void {
  host.replaceChildren()
  const origin = host.getBoundingClientRect()
  const lines: Line[] = []
  for (const target of article.querySelectorAll<HTMLElement>(TARGETS)) {
    // Clamped titles and the scrolling tab panel hide some lines; only visible ones are covered.
    const bounds = target.getBoundingClientRect()
    const own: Line[] = []
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      if (!node.textContent?.trim() || node.parentElement?.closest('[data-archive-unredacted]')) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      if (typeof range.getClientRects !== 'function') return
      for (const rect of range.getClientRects()) {
        if (!rect.width || !rect.height) continue
        const top = Math.max(rect.top, bounds.top)
        const bottom = Math.min(rect.bottom, bounds.bottom)
        // Even a fraction of the last line is visible and must receive a cover.
        if (bottom <= top) continue
        const x = Math.max(rect.left, bounds.left) - origin.left
        const y = top - origin.top
        const right = Math.min(rect.right, bounds.right) - origin.left
        if (right <= x) continue
        const lineBottom = bottom - origin.top
        const line = own.find((entry) => Math.abs(entry.y - y) < 6)
        if (line) {
          line.x = Math.min(line.x, x)
          line.y = Math.min(line.y, y)
          line.right = Math.max(line.right, right)
          line.bottom = Math.max(line.bottom, lineBottom)
        } else own.push({ x, y, right, bottom: lineBottom })
      }
    }
    lines.push(...own)
  }
  lines.sort((a, b) => a.y - b.y || a.x - b.x)
  for (const line of lines) {
    const window = document.createElement('span')
    window.className = 'paper-archive-redaction'
    window.style.cssText = `left:${(line.x - 1).toFixed(1)}px;top:${(line.y - 1).toFixed(1)}px;width:${(line.right - line.x + 2).toFixed(1)}px;height:${(line.bottom - line.y + 2).toFixed(1)}px`
    const ink = document.createElement('span')
    ink.className = 'paper-archive-redaction-ink'
    window.append(ink)
    host.append(window)
  }
}
