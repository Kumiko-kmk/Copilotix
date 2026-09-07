import React from 'react'

const MINIMAP_FRAME_MIN_HEIGHT = 24
const MINIMAP_HEADING_INDENTS = [4, 10, 16, 22, 28, 34] as const
const MINIMAP_KEYBOARD_STEP = 48
const MINIMAP_HORIZONTAL_PADDING = 4
const MINIMAP_IMAGE_MIN_HEIGHT = 3
const MINIMAP_FORMULA_MIN_HEIGHT = 2

export interface MarkdownMinimapTextRun {
  id: string
  text: string
  left: number
  baseline: number
  width: number
  fontSize: number
  fontWeight: string
  fontStyle: string
  tone: 'body' | 'code' | 'heading'
}

export interface MarkdownMinimapHeading {
  id: string
  top: number
  height: number
  left: number
  width: number
  documentTop: number
  headingLevel: number
  title: string
}

export interface MarkdownMinimapImage {
  id: string
  left: number
  top: number
  width: number
  height: number
  element: HTMLImageElement | HTMLCanvasElement
  sourceWidth: number
  sourceHeight: number
}

export interface MarkdownMinimapHighlight {
  id: string
  left: number
  top: number
  width: number
  height: number
}

export interface MarkdownMinimapFormula {
  id: string
  left: number
  top: number
  width: number
  height: number
  element: HTMLElement
  sourceWidth: number
  sourceHeight: number
  color: string
  fontFamily: string
  fontSize: string
}

export interface MarkdownMinimapContent {
  textRuns: MarkdownMinimapTextRun[]
  headings: MarkdownMinimapHeading[]
  images: MarkdownMinimapImage[]
  formulas: MarkdownMinimapFormula[]
  highlights: MarkdownMinimapHighlight[]
}

export default function MarkdownMinimap(props: {
  active: boolean
  ready: boolean
  layoutRevision: number
  controlledId: string
  scrollerRef: React.RefObject<HTMLDivElement | null>
  articleRef: React.RefObject<HTMLElement | null>
  yellowHighlightRanges?: readonly Range[]
  onDragStateChange?(dragging: boolean): void
}): React.JSX.Element {
  const railRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const formulaLayerRef = React.useRef<HTMLDivElement>(null)
  const frameRef = React.useRef<HTMLDivElement>(null)
  const frameRequestRef = React.useRef<number | null>(null)
  const pointerRequestRef = React.useRef<number | null>(null)
  const wheelRequestRef = React.useRef<number | null>(null)
  const draggingRef = React.useRef(false)
  const pendingPointerYRef = React.useRef<number | null>(null)
  const pendingWheelDeltaRef = React.useRef(0)
  const dragMetricsRef = React.useRef<DragMetrics | null>(null)
  const onDragStateChangeRef = React.useRef(props.onDragStateChange)
  onDragStateChangeRef.current = props.onDragStateChange
  const [content, setContent] = React.useState<MarkdownMinimapContent>(emptyMinimapContent)

  const updateFrame = React.useCallback(() => {
    const rail = railRef.current
    const frame = frameRef.current
    const scroller = props.scrollerRef.current
    if (!rail || !frame || !scroller) return
    const metrics = minimapFrameMetrics(scroller, rail.clientHeight)
    frame.style.setProperty('--markdown-minimap-frame-offset', `${metrics.top}px`)
    frame.style.setProperty('--markdown-minimap-frame-height', `${metrics.height}px`)
    frame.dataset.preview = 'false'
    rail.setAttribute('aria-valuemax', String(metrics.maxScroll))
    rail.setAttribute('aria-valuenow', String(Math.round(clamp(scroller.scrollTop, 0, metrics.maxScroll))))
  }, [props.scrollerRef])

  const scheduleFrameUpdate = React.useCallback(() => {
    if (frameRequestRef.current !== null) return
    frameRequestRef.current = window.requestAnimationFrame(() => {
      frameRequestRef.current = null
      updateFrame()
    })
  }, [updateFrame])

  React.useLayoutEffect(() => {
    if (!props.active || !props.ready) {
      setContent(emptyMinimapContent)
      return
    }
    const rail = railRef.current
    const scroller = props.scrollerRef.current
    const article = props.articleRef.current
    if (!rail || !scroller || !article) return
    article.classList.add('markdown-minimap-measuring')
    try {
      setContent(measureMarkdownMinimapContent(
        article,
        scroller,
        rail.clientWidth,
        rail.clientHeight,
        props.yellowHighlightRanges
      ))
    } finally {
      article.classList.remove('markdown-minimap-measuring')
    }
    updateFrame()
  }, [props.active, props.articleRef, props.layoutRevision, props.ready, props.scrollerRef, props.yellowHighlightRanges, updateFrame])

  React.useLayoutEffect(() => {
    const rail = railRef.current
    const canvas = canvasRef.current
    if (!rail || !canvas) return
    paintMarkdownMinimap(canvas, content, rail.clientWidth, rail.clientHeight, window.devicePixelRatio || 1)
    updateFrame()
  }, [content, updateFrame])

  React.useLayoutEffect(() => {
    const layer = formulaLayerRef.current
    if (!layer) return
    renderFormulaLayer(layer, content.formulas)
  }, [content])

  React.useEffect(() => {
    if (!props.active || !props.ready) return
    const scroller = props.scrollerRef.current
    if (!scroller) return
    scroller.addEventListener('scroll', scheduleFrameUpdate, { passive: true })
    return () => scroller.removeEventListener('scroll', scheduleFrameUpdate)
  }, [props.active, props.ready, props.scrollerRef, scheduleFrameUpdate])

  React.useEffect(() => () => {
    if (frameRequestRef.current !== null) window.cancelAnimationFrame(frameRequestRef.current)
    if (pointerRequestRef.current !== null) window.cancelAnimationFrame(pointerRequestRef.current)
    if (wheelRequestRef.current !== null) window.cancelAnimationFrame(wheelRequestRef.current)
  }, [])

  const writeFrame = React.useCallback((top: number, height: number, preview: boolean) => {
    const frame = frameRef.current
    if (!frame) return
    frame.style.setProperty('--markdown-minimap-frame-offset', `${top}px`)
    frame.style.setProperty('--markdown-minimap-frame-height', `${height}px`)
    frame.dataset.preview = String(preview)
  }, [])

  const previewAtPointer = React.useCallback((clientY: number) => {
    const rail = railRef.current
    const frame = frameRef.current
    const scroller = props.scrollerRef.current
    if (!rail || !frame || !scroller) return
    const bounds = rail.getBoundingClientRect()
    const metrics = minimapFrameMetrics(scroller, rail.clientHeight)
    const pointerY = clamp(clientY - bounds.top, 0, rail.clientHeight)
    const top = clamp(pointerY - metrics.height / 2, 0, Math.max(0, rail.clientHeight - metrics.height))
    writeFrame(top, metrics.height, true)
  }, [props.scrollerRef, writeFrame])

  const readDragMetrics = React.useCallback((): DragMetrics | null => {
    const rail = railRef.current
    const scroller = props.scrollerRef.current
    if (!rail || !scroller) return null
    const bounds = rail.getBoundingClientRect()
    const metrics = minimapFrameMetrics(scroller, rail.clientHeight)
    const frameTravel = Math.max(0, rail.clientHeight - metrics.height)
    return {
      railTop: bounds.top,
      railHeight: rail.clientHeight,
      frameHeight: metrics.height,
      frameTravel,
      maxScroll: metrics.maxScroll
    }
  }, [props.scrollerRef])

  const scrollToPointer = React.useCallback((clientY: number, cached = dragMetricsRef.current) => {
    const scroller = props.scrollerRef.current
    if (!scroller || !cached) return
    const pointerY = clamp(clientY - cached.railTop, 0, cached.railHeight)
    const frameTravel = cached.frameTravel
    const targetFrameTop = clamp(pointerY - cached.frameHeight / 2, 0, frameTravel)
    const targetScrollTop = frameTravel > 0 ? targetFrameTop / frameTravel * cached.maxScroll : 0
    scroller.scrollTop = targetScrollTop
    writeFrame(targetFrameTop, cached.frameHeight, false)
  }, [props.scrollerRef, writeFrame])

  const schedulePointerScroll = React.useCallback((clientY: number) => {
    pendingPointerYRef.current = clientY
    if (pointerRequestRef.current !== null) return
    pointerRequestRef.current = window.requestAnimationFrame(() => {
      pointerRequestRef.current = null
      const pending = pendingPointerYRef.current
      pendingPointerYRef.current = null
      if (pending !== null) scrollToPointer(pending)
    })
  }, [scrollToPointer])

  const onPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-minimap-heading]')) return
    event.preventDefault()
    event.currentTarget.focus()
    draggingRef.current = true
    dragMetricsRef.current = readDragMetrics()
    event.currentTarget.dataset.dragging = 'true'
    onDragStateChangeRef.current?.(true)
    event.currentTarget.setPointerCapture?.(event.pointerId)
    schedulePointerScroll(event.clientY)
  }, [readDragMetrics, schedulePointerScroll])

  const onPointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) schedulePointerScroll(event.clientY)
    else previewAtPointer(event.clientY)
  }, [previewAtPointer, schedulePointerScroll])

  const finishPointerDrag = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    if (pointerRequestRef.current !== null) {
      window.cancelAnimationFrame(pointerRequestRef.current)
      pointerRequestRef.current = null
      const pending = pendingPointerYRef.current
      pendingPointerYRef.current = null
      if (pending !== null) scrollToPointer(pending)
    }
    dragMetricsRef.current = null
    event.currentTarget.dataset.dragging = 'false'
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    updateFrame()
    onDragStateChangeRef.current?.(false)
  }, [scrollToPointer, updateFrame])

  const onWheel = React.useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const scroller = props.scrollerRef.current
    if (!scroller) return
    event.preventDefault()
    pendingWheelDeltaRef.current += event.deltaY + event.deltaX
    if (wheelRequestRef.current !== null) return
    wheelRequestRef.current = window.requestAnimationFrame(() => {
      wheelRequestRef.current = null
      const delta = pendingWheelDeltaRef.current
      pendingWheelDeltaRef.current = 0
      setScrollerTop(scroller, scroller.scrollTop + delta)
      updateFrame()
    })
  }, [props.scrollerRef, updateFrame])

  const onKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const scroller = props.scrollerRef.current
    if (!scroller) return
    let target: number | null = null
    if (event.key === 'ArrowUp') target = scroller.scrollTop - MINIMAP_KEYBOARD_STEP
    else if (event.key === 'ArrowDown') target = scroller.scrollTop + MINIMAP_KEYBOARD_STEP
    else if (event.key === 'PageUp') target = scroller.scrollTop - scroller.clientHeight
    else if (event.key === 'PageDown') target = scroller.scrollTop + scroller.clientHeight
    else if (event.key === 'Home') target = 0
    else if (event.key === 'End') target = maximumScroll(scroller)
    if (target === null) return
    event.preventDefault()
    setScrollerTop(scroller, target)
    scheduleFrameUpdate()
  }, [props.scrollerRef, scheduleFrameUpdate])

  const jumpToHeading = React.useCallback((heading: MarkdownMinimapHeading) => {
    const scroller = props.scrollerRef.current
    if (!scroller) return
    scrollScrollerTo(scroller, heading.documentTop - 16)
    scheduleFrameUpdate()
  }, [props.scrollerRef, scheduleFrameUpdate])

  return (
    <div
      ref={railRef}
      className="markdown-minimap"
      role="scrollbar"
      aria-label="Markdown 文档缩略导航"
      aria-controls={props.controlledId}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={0}
      aria-valuenow={0}
      aria-disabled={!props.active || !props.ready}
      tabIndex={props.active && props.ready ? 0 : -1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={() => { if (!draggingRef.current) updateFrame() }}
      onPointerUp={finishPointerDrag}
      onPointerCancel={finishPointerDrag}
      onLostPointerCapture={finishPointerDrag}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvasRef} className="markdown-minimap-canvas" aria-hidden="true" />
      <div ref={formulaLayerRef} className="markdown-minimap-formulas" aria-hidden="true" />
      {content.headings.map((heading) => (
        <button
          key={heading.id}
          type="button"
          className={`markdown-minimap-heading heading-${heading.headingLevel}`}
          data-minimap-heading={heading.headingLevel}
          title={heading.title}
          aria-label={`跳转到${heading.title}`}
          style={{ top: heading.top, left: heading.left, width: heading.width, height: heading.height }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => jumpToHeading(heading)}
        />
      ))}
      <div ref={frameRef} className="markdown-minimap-frame" data-preview="false" aria-hidden="true" />
    </div>
  )
}

export function measureMarkdownMinimapContent(
  article: HTMLElement,
  scroller: HTMLElement,
  railWidth: number,
  railHeight: number,
  yellowHighlightRanges: readonly Range[] = []
): MarkdownMinimapContent {
  if (railWidth <= 0 || railHeight <= 0 || scroller.scrollHeight <= 0) return emptyMinimapContent
  const articleBounds = article.getBoundingClientRect()
  const scrollerBounds = scroller.getBoundingClientRect()
  const horizontalScale = Math.max(0, railWidth - MINIMAP_HORIZONTAL_PADDING * 2) / Math.max(1, articleBounds.width)
  const verticalScale = railHeight / scroller.scrollHeight
  const textRuns: MarkdownMinimapTextRun[] = []
  const headings = measureHeadings(article, scroller, scrollerBounds, railWidth, railHeight)
  const highlights = measureHighlightRanges(
    yellowHighlightRanges,
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
  return { textRuns, headings, images, formulas, highlights }
}

function measureHighlightRanges(
  ranges: readonly Range[],
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

export function paintMarkdownMinimap(
  canvas: HTMLCanvasElement,
  content: MarkdownMinimapContent,
  width: number,
  height: number,
  pixelRatio: number,
  providedContext?: CanvasRenderingContext2D
): void {
  const ratio = Math.max(1, pixelRatio)
  canvas.width = Math.max(1, Math.round(width * ratio))
  canvas.height = Math.max(1, Math.round(height * ratio))
  const context = providedContext ?? (typeof CanvasRenderingContext2D === 'undefined' ? null : canvas.getContext('2d'))
  if (!context) return
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, width, height)
  const railStyle = window.getComputedStyle(canvas.parentElement ?? canvas)
  const textColor = railStyle.getPropertyValue('--text').trim() || '#3f3a34'
  const mutedColor = railStyle.getPropertyValue('--muted').trim() || '#756e65'

  context.fillStyle = '#f4c542'
  context.globalAlpha = 0.58
  for (const highlight of content.highlights) {
    context.fillRect(highlight.left, highlight.top, highlight.width, highlight.height)
  }

  context.strokeStyle = mutedColor
  context.lineWidth = 0.75
  for (const image of content.images) {
    const target = containRect(image.sourceWidth, image.sourceHeight, image)
    try {
      if (!minimapImageReady(image.element)) {
        throw new Error('minimap image is unavailable')
      }
      context.globalAlpha = 0.82
      context.drawImage(image.element, target.left, target.top, target.width, target.height)
    } catch {
      context.globalAlpha = 0.32
      context.strokeRect(target.left, target.top, target.width, target.height)
    }
  }

  context.textBaseline = 'alphabetic'
  for (const run of content.textRuns) {
    context.globalAlpha = run.tone === 'heading' ? 0.82 : run.tone === 'code' ? 0.62 : 0.48
    context.fillStyle = run.tone === 'body' ? mutedColor : textColor
    const family = run.tone === 'code' ? 'Consolas, "SFMono-Regular", monospace' : 'Inter, "Microsoft YaHei UI", sans-serif'
    context.font = `${run.fontStyle} ${run.fontWeight} ${run.fontSize}px ${family}`
    context.fillText(run.text, run.left, run.baseline, run.width)
  }
  context.globalAlpha = 1
}

function minimapImageReady(element: HTMLImageElement | HTMLCanvasElement): boolean {
  return element instanceof HTMLCanvasElement
    ? element.width > 0 && element.height > 0
    : element.complete && element.naturalWidth > 0 && element.naturalHeight > 0
}

export function containRect(
  sourceWidth: number,
  sourceHeight: number,
  target: Pick<MarkdownMinimapImage, 'left' | 'top' | 'width' | 'height'>
): { left: number; top: number; width: number; height: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0 || target.width <= 0 || target.height <= 0) {
    return { left: target.left, top: target.top, width: 0, height: 0 }
  }
  const scale = Math.min(target.width / sourceWidth, target.height / sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale
  return {
    left: target.left + (target.width - width) / 2,
    top: target.top + (target.height - height) / 2,
    width,
    height
  }
}

export function renderFormulaLayer(layer: HTMLElement, formulas: MarkdownMinimapFormula[]): void {
  const fragment = document.createDocumentFragment()
  for (const formula of formulas) {
    const target = containRect(formula.sourceWidth, formula.sourceHeight, formula)
    if (target.width <= 0 || target.height <= 0) continue
    const holder = document.createElement('span')
    holder.className = 'markdown-minimap-formula'
    holder.setAttribute('aria-hidden', 'true')
    holder.inert = true
    holder.style.left = `${target.left}px`
    holder.style.top = `${target.top}px`
    holder.style.width = `${formula.sourceWidth}px`
    holder.style.height = `${formula.sourceHeight}px`
    holder.style.color = formula.color
    holder.style.fontFamily = formula.fontFamily
    holder.style.fontSize = formula.fontSize
    holder.style.transform = `scale(${target.width / formula.sourceWidth})`
    const clone = formula.element.cloneNode(true) as HTMLElement
    clone.removeAttribute('id')
    for (const descendant of clone.querySelectorAll<HTMLElement>('[id]')) descendant.removeAttribute('id')
    holder.append(clone)
    fragment.append(holder)
  }
  layer.replaceChildren(fragment)
}

export function minimapFrameMetrics(
  scroller: Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'>,
  railHeight: number
): { top: number; height: number; maxScroll: number } {
  const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  if (railHeight <= 0 || scroller.scrollHeight <= 0 || maxScroll === 0) {
    return { top: 0, height: Math.max(0, railHeight), maxScroll }
  }
  const height = Math.min(railHeight, Math.max(MINIMAP_FRAME_MIN_HEIGHT, scroller.clientHeight / scroller.scrollHeight * railHeight))
  const top = clamp(scroller.scrollTop, 0, maxScroll) / maxScroll * Math.max(0, railHeight - height)
  return { top, height, maxScroll }
}

function measureHeadings(
  article: HTMLElement,
  scroller: HTMLElement,
  scrollerBounds: DOMRect,
  railWidth: number,
  railHeight: number
): MarkdownMinimapHeading[] {
  return Array.from(article.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')).map((heading, index) => {
    const bounds = heading.getBoundingClientRect()
    const headingLevel = headingLevelOf(heading) ?? 6
    const documentTop = bounds.top - scrollerBounds.top + scroller.scrollTop
    const top = documentTop / scroller.scrollHeight * railHeight
    const left = MINIMAP_HEADING_INDENTS[headingLevel - 1] ?? 34
    return {
      id: `minimap-heading-${index}`,
      top: clamp(top, 0, Math.max(0, railHeight - 8)),
      height: 8,
      left,
      width: Math.max(8, railWidth - left - 4),
      documentTop,
      headingLevel,
      title: normalizeMinimapTitle(heading.textContent)
    }
  })
}

function measureTextFragments(textNode: Text, parent: HTMLElement): Array<{ text: string; bounds: DOMRect }> {
  const fallback = [{ text: textNode.data, bounds: parent.getBoundingClientRect() }]
  const range = document.createRange()
  if (typeof range.getClientRects !== 'function') return fallback
  const fragments: Array<{ text: string; bounds: DOMRect }> = []
  for (const segment of segmentText(textNode.data)) {
    if (!segment.text.trim()) continue
    range.setStart(textNode, segment.start)
    range.setEnd(textNode, segment.end)
    const rects = Array.from(range.getClientRects()).filter((bounds) => bounds.width > 0 && bounds.height > 0)
    if (rects.length === 1 && rects[0]) fragments.push({ text: segment.text, bounds: rects[0] })
    else if (rects.length > 1) fragments.push(...measureGraphemeFragments(textNode, segment.start, segment.text))
  }
  range.detach()
  return fragments.length > 0 ? fragments : fallback
}

function measureGraphemeFragments(textNode: Text, start: number, text: string): Array<{ text: string; bounds: DOMRect }> {
  const fragments: Array<{ text: string; bounds: DOMRect }> = []
  const range = document.createRange()
  let offset = start
  for (const grapheme of Array.from(text)) {
    const end = offset + grapheme.length
    range.setStart(textNode, offset)
    range.setEnd(textNode, end)
    const bounds = range.getBoundingClientRect()
    if (grapheme.trim() && bounds.width > 0 && bounds.height > 0) fragments.push({ text: grapheme, bounds })
    offset = end
  }
  range.detach()
  return fragments
}

function segmentText(text: string): Array<{ text: string; start: number; end: number }> {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
  return Array.from(segmenter.segment(text), ({ segment, index }) => ({ text: segment, start: index, end: index + segment.length }))
}

function isVisibleMinimapContent(element: HTMLElement): boolean {
  if (element.closest('script, style, noscript, template, [hidden], .katex-mathml, .reader-figure-hidden-source, .reader-figure-fallback')) return false
  const style = window.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

function normalizeCanvasText(value: string, parent: HTMLElement): string {
  return parent.closest('pre, code') ? value.replace(/[\r\n]+/g, ' ') : value.replace(/\s+/g, ' ')
}

function headingLevelOf(element: HTMLElement): number | null {
  const match = /^H([1-6])$/.exec(element.tagName)
  return match ? Number(match[1]) : null
}

function normalizeMinimapTitle(value: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim() || '未命名章节'
}

function maximumScroll(scroller: Pick<HTMLElement, 'clientHeight' | 'scrollHeight'>): number {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight)
}

function setScrollerTop(scroller: HTMLElement, target: number): void {
  scroller.scrollTop = clamp(target, 0, maximumScroll(scroller))
}

function scrollScrollerTo(scroller: HTMLElement, target: number): void {
  const top = clamp(target, 0, maximumScroll(scroller))
  if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top, behavior: 'smooth' })
  else scroller.scrollTop = top
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

interface DragMetrics {
  railTop: number
  railHeight: number
  frameHeight: number
  frameTravel: number
  maxScroll: number
}

const emptyMinimapContent: MarkdownMinimapContent = { textRuns: [], headings: [], images: [], formulas: [], highlights: [] }
