
import { clamp, createMarkdownMinimapGeometry, emptyMinimapGeometry } from './minimapPaint'
import { type MarkdownMinimapTextRun, type MarkdownMinimapHeading, type MarkdownMinimapHighlight, type MarkdownMinimapContent, type MarkdownMinimapGeometry, type MinimapNavigationAnchor } from './minimapTypes'

/** Measuring a rendered Markdown article into minimap content (text runs, headings, images, formulas) and navigation anchors. */

export const MINIMAP_HORIZONTAL_PADDING = 4

export const MINIMAP_HEADING_INDENTS = [4, 10, 16, 22, 28, 34] as const
export const MINIMAP_IMAGE_MIN_HEIGHT = 3
export const MINIMAP_FORMULA_MIN_HEIGHT = 2

export interface MinimapSnapshotKey {
  article: HTMLElement
  visualRevision?: string
  width: number
  railWidth: number
  railHeight: number
  viewportHeight: number
}

export function measureNavigationAnchors(article: HTMLElement, scroller: HTMLElement): MinimapNavigationAnchor[] {
  const top = scroller.getBoundingClientRect().top - scroller.scrollTop
  const anchors: MinimapNavigationAnchor[] = [{ sourceTop: 0, liveTop: 0 }]
  for (const element of article.querySelectorAll<HTMLElement>('.markdown-block')) {
    const bounds = element.getBoundingClientRect()
    if (bounds.height <= 0) continue
    for (const edge of ['top', 'bottom'] as const) {
      const offset = bounds[edge] - top
      anchors.push({ sourceTop: offset, liveTop: offset, element, edge })
    }
  }
  for (const element of article.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
    const offset = element.getBoundingClientRect().top - top
    anchors.push({ sourceTop: offset, liveTop: offset, element, edge: 'top' })
  }
  anchors.push({ sourceTop: scroller.scrollHeight, liveTop: scroller.scrollHeight })
  return anchors.sort((left, right) => left.sourceTop - right.sourceTop)
}

export function refreshNavigationAnchors(anchors: MinimapNavigationAnchor[], scroller: HTMLElement): void {
  const top = scroller.getBoundingClientRect().top - scroller.scrollTop
  for (const anchor of anchors) {
    if (anchor.element && anchor.edge) anchor.liveTop = anchor.element.getBoundingClientRect()[anchor.edge] - top
  }
  if (anchors.length > 0) anchors[anchors.length - 1]!.liveTop = scroller.scrollHeight
}

export function mapMinimapOffset(value: number, anchors: readonly MinimapNavigationAnchor[], from: 'source' | 'live'): number {
  if (anchors.length < 2) return value
  const input = from === 'source' ? 'sourceTop' : 'liveTop'
  const output = from === 'source' ? 'liveTop' : 'sourceTop'
  let low = 0
  let high = anchors.length - 1
  while (low + 1 < high) {
    const middle = (low + high) >>> 1
    if (anchors[middle]![input] <= value) low = middle
    else high = middle
  }
  const start = anchors[low]!
  const end = anchors[high]!
  const span = end[input] - start[input]
  const ratio = span > 0 ? clamp((value - start[input]) / span, 0, 1) : 0
  return start[output] + ratio * (end[output] - start[output])
}

export function captureStaticMarkdownMinimap(
  article: HTMLElement,
  scroller: HTMLElement,
  railWidth: number,
  railHeight: number,
  yellowHighlightRanges: readonly Range[] = []
): MarkdownMinimapContent {
  return resolveMarkdownLayout(article, () =>
    measureMarkdownMinimapContent(article, scroller, railWidth, railHeight, yellowHighlightRanges)
  )
}

export function resolveMarkdownLayout<T>(article: HTMLElement, measure: () => T): T {
  const blocks = Array.from(article.querySelectorAll<HTMLElement>('.markdown-block'))
  const visibility = blocks.map((block) => block.style.contentVisibility)
  const articleVisibility = article.style.visibility
  // Preparation measures the hidden article synchronously and restores it
  // before the browser can paint; inherited visibility must not exclude text.
  article.style.visibility = 'visible'
  // Resolve every offscreen block once instead of capturing its 48px estimated height.
  blocks.forEach((block) => { block.style.contentVisibility = 'visible' })
  try {
    const heights = blocks.map((block) => {
      const style = window.getComputedStyle(block)
      const inset = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'] as const
      return Math.max(0, block.getBoundingClientRect().height -
        inset.reduce((total, property) => total + (Number.parseFloat(style[property]) || 0), 0))
    })
    const content = measure()
    // Explicit sizes prevent the browser's remembered size from an older width taking precedence.
    blocks.forEach((block, index) => { block.style.containIntrinsicBlockSize = `${heights[index]}px` })
    return content
  } finally {
    article.style.visibility = articleVisibility
    blocks.forEach((block, index) => { block.style.contentVisibility = visibility[index]! })
  }
}

export function measureMarkdownMinimapContent(
  article: HTMLElement,
  scroller: HTMLElement,
  railWidth: number,
  railHeight: number,
  yellowHighlightRanges: readonly Range[] = []
): MarkdownMinimapContent {
  if (railWidth <= 0 || railHeight <= 0 || scroller.scrollHeight <= 0) return emptyMinimapContent
  const geometry = createMarkdownMinimapGeometry(scroller, railWidth, railHeight)
  const articleBounds = article.getBoundingClientRect()
  const scrollerBounds = scroller.getBoundingClientRect()
  const horizontalScale = Math.max(0, railWidth - MINIMAP_HORIZONTAL_PADDING * 2) / Math.max(1, articleBounds.width)
  const verticalScale = geometry.verticalScale
  const textRuns: MarkdownMinimapTextRun[] = []
  const headings = measureHeadings(article, scroller, scrollerBounds, railWidth, geometry)
  const highlights = measureHighlightRanges(
    yellowHighlightRanges,
    article,
    articleBounds,
    scrollerBounds,
    scroller.scrollTop,
    horizontalScale,
    verticalScale,
    railWidth,
    railHeight
  )
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  let runIndex = 0
  while (node) {
    const textNode = node as Text
    const parent = textNode.parentElement
    if (parent && !parent.closest('.katex') && isVisibleMinimapContent(parent) && textNode.data.trim()) {
      const style = window.getComputedStyle(parent)
      const heading = parent.closest<HTMLElement>('h1, h2, h3, h4, h5, h6')
      const headingLevel = heading ? headingLevelOf(heading) : null
      const headingBounds = heading?.getBoundingClientRect()
      for (const fragment of measureTextFragments(textNode, parent)) {
        const documentTop = fragment.bounds.top - scrollerBounds.top + scroller.scrollTop
        const sourceLeft = headingBounds && headingLevel
          ? (MINIMAP_HEADING_INDENTS[headingLevel - 1] ?? 34) + (fragment.bounds.left - headingBounds.left) * horizontalScale
          : MINIMAP_HORIZONTAL_PADDING + (fragment.bounds.left - articleBounds.left) * horizontalScale
        const sourceFontSize = Number.parseFloat(style.fontSize) || 16
        const tone = headingLevel !== null ? 'heading' : parent.closest('pre, code') ? 'code' : 'body'
        textRuns.push({
          id: `minimap-text-${runIndex++}`,
          text: normalizeCanvasText(fragment.text, parent),
          left: clamp(sourceLeft, 0, railWidth),
          baseline: clamp((documentTop + fragment.bounds.height * 0.82) * verticalScale, 0, railHeight),
          width: Math.max(0.75, Math.min(Math.max(0.75, railWidth - sourceLeft), fragment.bounds.width * horizontalScale)),
          fontSize: clamp(
            sourceFontSize * Math.min(horizontalScale, Math.max(verticalScale, 0.07)),
            tone === 'heading' ? 2 : 1.15,
            tone === 'heading' ? 3.8 : 2.6
          ),
          fontWeight: style.fontWeight || '400',
          fontStyle: style.fontStyle || 'normal',
          tone
        })
      }
    }
    node = walker.nextNode()
  }

  const images = Array.from(article.querySelectorAll<HTMLImageElement | HTMLCanvasElement>('img, canvas.reader-figure-snapshot-canvas')).flatMap((image, index) => {
    if (!isVisibleMinimapContent(image)) return []
    if (image instanceof HTMLCanvasElement && image.closest('.reader-figure-snapshot[data-rendered="false"]')) return []
    const bounds = image.getBoundingClientRect()
    const documentTop = bounds.top - scrollerBounds.top + scroller.scrollTop
    return [{
      id: `minimap-image-${index}`,
      left: clamp(MINIMAP_HORIZONTAL_PADDING + (bounds.left - articleBounds.left) * horizontalScale, 0, railWidth),
      top: clamp(documentTop * verticalScale, 0, railHeight),
      width: clamp(bounds.width * horizontalScale, 1, railWidth),
      height: clamp(
        Math.max(MINIMAP_IMAGE_MIN_HEIGHT, bounds.height * verticalScale),
        1,
        Math.max(1, railHeight - documentTop * verticalScale)
      ),
      element: image,
      sourceWidth: image instanceof HTMLImageElement ? image.naturalWidth || bounds.width : image.width || bounds.width,
      sourceHeight: image instanceof HTMLImageElement ? image.naturalHeight || bounds.height : image.height || bounds.height
    }]
  })
  const formulas = Array.from(article.querySelectorAll<HTMLElement>('.katex')).flatMap((formula, index) => {
    if (formula.parentElement?.closest('.katex') || !isVisibleMinimapContent(formula)) return []
    const bounds = formula.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return []
    const style = window.getComputedStyle(formula)
    const documentTop = bounds.top - scrollerBounds.top + scroller.scrollTop
    return [{
      id: `minimap-formula-${index}`,
      left: clamp(MINIMAP_HORIZONTAL_PADDING + (bounds.left - articleBounds.left) * horizontalScale, 0, railWidth),
      top: clamp(documentTop * verticalScale, 0, railHeight),
      width: clamp(bounds.width * horizontalScale, 1, railWidth),
      height: clamp(
        Math.max(MINIMAP_FORMULA_MIN_HEIGHT, bounds.height * verticalScale),
        1,
        Math.max(1, railHeight - documentTop * verticalScale)
      ),
      element: formula,
      sourceWidth: bounds.width,
      sourceHeight: bounds.height,
      color: style.color,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize
    }]
  })
  return { geometry, textRuns, headings, images, formulas, highlights }
}

export function measureHighlightRanges(
  ranges: readonly Range[],
  article: HTMLElement,
  articleBounds: DOMRect,
  scrollerBounds: DOMRect,
  scrollTop: number,
  horizontalScale: number,
  verticalScale: number,
  railWidth: number,
  railHeight: number
): MarkdownMinimapHighlight[] {
  const highlights: MarkdownMinimapHighlight[] = []
  let index = 0
  for (const range of ranges) {
    if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) continue
    let rects: DOMRect[]
    try {
      rects = Array.from(range.getClientRects())
    } catch {
      continue
    }
    for (const bounds of rects) {
      if (bounds.width <= 0 || bounds.height <= 0) continue
      const documentTop = bounds.top - scrollerBounds.top + scrollTop
      const left = clamp(MINIMAP_HORIZONTAL_PADDING + (bounds.left - articleBounds.left) * horizontalScale, 0, railWidth)
      const top = clamp(documentTop * verticalScale, 0, railHeight)
      highlights.push({
        id: `minimap-highlight-${index++}`,
        left,
        top,
        width: clamp(bounds.width * horizontalScale, 1, Math.max(1, railWidth - left)),
        height: clamp(Math.max(1.5, bounds.height * verticalScale), 1, Math.max(1, railHeight - top))
      })
    }
  }
  return highlights
}

export function measureHeadings(
  article: HTMLElement,
  scroller: HTMLElement,
  scrollerBounds: DOMRect,
  railWidth: number,
  geometry: MarkdownMinimapGeometry
): MarkdownMinimapHeading[] {
  return Array.from(article.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')).map((heading, index) => {
    const bounds = heading.getBoundingClientRect()
    const headingLevel = headingLevelOf(heading) ?? 6
    const documentTop = bounds.top - scrollerBounds.top + scroller.scrollTop
    const top = documentTop * geometry.verticalScale
    const left = MINIMAP_HEADING_INDENTS[headingLevel - 1] ?? 34
    return {
      id: `minimap-heading-${index}`,
      top: clamp(top, 0, Math.max(0, geometry.railHeight - 8)),
      height: 8,
      left,
      width: Math.max(8, railWidth - left - 4),
      documentTop,
      headingLevel,
      title: normalizeMinimapTitle(heading.textContent),
      element: heading
    }
  })
}

export function measureTextFragments(textNode: Text, parent: HTMLElement): Array<{ text: string; bounds: DOMRect }> {
  const fallback = [{ text: textNode.data, bounds: parent.getBoundingClientRect() }]
  const range = document.createRange()
  if (typeof range.getClientRects !== 'function') return fallback
  range.selectNodeContents(textNode)
  const rects = Array.from(range.getClientRects()).filter((bounds) => bounds.width > 0 && bounds.height > 0)
  range.detach()
  if (rects.length === 0) return fallback
  const text = textNode.data.replace(/\s+/g, ' ').trim()
  const totalWidth = rects.reduce((sum, bounds) => sum + bounds.width, 0)
  let textOffset = 0
  return rects.map((bounds, index) => {
    const remaining = text.length - textOffset
    const length = index === rects.length - 1
      ? remaining
      : Math.max(1, Math.min(remaining, Math.round(text.length * bounds.width / Math.max(1, totalWidth))))
    const fragment = text.slice(textOffset, textOffset + length)
    textOffset += length
    return { text: fragment, bounds }
  })
}

export function scheduleIdleMeasurement(callback: () => void): () => void {
  const idleWindow = window as Window & {
    requestIdleCallback?: (handler: () => void, options?: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (idleWindow.requestIdleCallback) {
    const id = idleWindow.requestIdleCallback(callback, { timeout: 500 })
    return () => idleWindow.cancelIdleCallback?.(id)
  }
  const id = window.setTimeout(callback, 32)
  return () => window.clearTimeout(id)
}

export function isVisibleMinimapContent(element: HTMLElement): boolean {
  if (element.closest('script, style, noscript, template, [hidden], .katex-mathml, .reader-figure-hidden-source, .reader-figure-action')) return false
  const style = window.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

export function normalizeCanvasText(value: string, parent: HTMLElement): string {
  return parent.closest('pre, code') ? value.replace(/[\r\n]+/g, ' ') : value.replace(/\s+/g, ' ')
}

export function headingLevelOf(element: HTMLElement): number | null {
  const match = /^H([1-6])$/.exec(element.tagName)
  return match ? Number(match[1]) : null
}

export function normalizeMinimapTitle(value: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim() || '未命名章节'
}

export const emptyMinimapContent: MarkdownMinimapContent = {
  geometry: emptyMinimapGeometry,
  textRuns: [],
  headings: [],
  images: [],
  formulas: [],
  highlights: []
}
