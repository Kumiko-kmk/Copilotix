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
  }, [root, layer, covered, reveal, content])

  React.useLayoutEffect(() => {
    const host = layer.current
    if (!host || !reveal || revealedRef.current) return
    revealedRef.current = true
    const inks = [...host.querySelectorAll<HTMLElement>('.paper-archive-redaction-ink')]
    if (!inks.length || typeof inks[0]!.animate !== 'function') {
      host.replaceChildren()
      return
    }
    const animations = inks.map((ink, order) => ink.animate(
      Array.from({ length: SAMPLES + 1 }, (_, step) => ({
        transform: `translateX(${(redactionOffset(step / SAMPLES, order, inks.length) * 101).toFixed(2)}%)`
      })),
      { duration: REDACTION_SECONDS * 1000, easing: 'linear', fill: 'forwards' }
    ))
    void Promise.all(animations.map((animation) => animation.finished)).then(() => host.replaceChildren(), () => undefined)
    return () => animations.forEach((animation) => animation.cancel())
  }, [layer, reveal])
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
      if (!node.textContent?.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      if (typeof range.getClientRects !== 'function') return
      for (const rect of range.getClientRects()) {
        if (!rect.width || !rect.height) continue
        const top = Math.max(rect.top, bounds.top)
        const bottom = Math.min(rect.bottom, bounds.bottom)
        if (bottom - top < rect.height * 0.5) continue
        const x = rect.left - origin.left
        const y = top - origin.top
        const right = Math.min(rect.right, bounds.right) - origin.left
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
