import React from 'react'
import { recordReaderDuration } from '../readerPerformance'
import { measureNavigationAnchors, refreshNavigationAnchors, mapMinimapOffset, resolveMarkdownLayout, measureMarkdownMinimapContent, scheduleIdleMeasurement, emptyMinimapContent, type MinimapSnapshotKey } from './minimapMeasure'
import { type MarkdownMinimapHeading, type MarkdownMinimapContent, type MarkdownMinimapGeometry, type MinimapNavigationAnchor } from './minimapTypes'
import { paintMarkdownMinimap, renderFormulaLayer, maximumScroll, setScrollerTop, scrollScrollerTo, clamp, frameDisplayMetrics, writeFrameStyles, emptyMinimapGeometry, type DragMetrics } from './minimapPaint'
export { paintMarkdownMinimap, containRect, renderFormulaLayer, minimapFrameMetrics, createMarkdownMinimapGeometry } from './minimapPaint'

export { mapMinimapOffset, captureStaticMarkdownMinimap, measureMarkdownMinimapContent } from './minimapMeasure'

export type { MarkdownMinimapTextRun, MarkdownMinimapHeading, MarkdownMinimapImage, MarkdownMinimapHighlight, MarkdownMinimapFormula, MarkdownMinimapContent, MarkdownMinimapGeometry, MinimapNavigationAnchor } from './minimapTypes'

const MINIMAP_KEYBOARD_STEP = 48
export default function MarkdownMinimap(props: {
  active: boolean
  ready: boolean
  layoutRevision: number
  visualRevision?: string
  controlledId: string
  scrollerRef: React.RefObject<HTMLDivElement | null>
  articleRef: React.RefObject<HTMLElement | null>
  yellowHighlightRanges?: readonly Range[]
  onPrepared?(): void
  onDragStateChange?(dragging: boolean): void
}): React.JSX.Element {
  const railRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const formulaLayerRef = React.useRef<HTMLDivElement>(null)
  const staticLayerRef = React.useRef<HTMLDivElement>(null)
  const frameRef = React.useRef<HTMLDivElement>(null)
  const frameHitRef = React.useRef<HTMLDivElement>(null)
  const frameRequestRef = React.useRef<number | null>(null)
  const pointerRequestRef = React.useRef<number | null>(null)
  const wheelRequestRef = React.useRef<number | null>(null)
  const measurementCancelRef = React.useRef<(() => void) | null>(null)
  const draggingRef = React.useRef(false)
  const pendingPointerYRef = React.useRef<number | null>(null)
  const pendingWheelDeltaRef = React.useRef(0)
  const dragMetricsRef = React.useRef<DragMetrics | null>(null)
  const geometryRef = React.useRef<MarkdownMinimapGeometry>(emptyMinimapGeometry)
  const snapshotRef = React.useRef<MinimapSnapshotKey | null>(null)
  const navigationRef = React.useRef<MinimapNavigationAnchor[]>([])
  const onDragStateChangeRef = React.useRef(props.onDragStateChange)
  onDragStateChangeRef.current = props.onDragStateChange
  const [content, setContent] = React.useState<MarkdownMinimapContent>(emptyMinimapContent)
  const onPreparedRef = React.useRef(props.onPrepared)
  onPreparedRef.current = props.onPrepared

  const updateFrame = React.useCallback(() => {
    const rail = railRef.current
    const frame = frameRef.current
    const scroller = props.scrollerRef.current
    if (!rail || !frame || !scroller) return
    const snapshot = snapshotRef.current
    if (snapshot && snapshot.width !== snapshot.article.getBoundingClientRect().width) {
      // Resize indexing can be deferred while scrolling. Refresh the live
      // navigation coordinates before using the retained overview geometry.
      resolveMarkdownLayout(snapshot.article, () => {
        refreshNavigationAnchors(navigationRef.current, scroller)
      })
      snapshot.width = snapshot.article.getBoundingClientRect().width
    }
    const source = geometryRef.current
    const scale = rail.clientHeight / Math.max(1, source.documentHeight)
    const top = mapMinimapOffset(scroller.scrollTop, navigationRef.current, 'live') * scale
    const bottom = mapMinimapOffset(scroller.scrollTop + scroller.clientHeight, navigationRef.current, 'live') * scale
    const metrics = frameDisplayMetrics(top, Math.max(0, bottom - top), rail.clientHeight, maximumScroll(scroller))
    if (staticLayerRef.current && source.railWidth > 0 && source.railHeight > 0) {
      staticLayerRef.current.style.transform = `scale(${rail.clientWidth / source.railWidth}, ${rail.clientHeight / source.railHeight})`
    }
    writeFrameStyles(frame, frameHitRef.current, metrics, false)
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

  React.useEffect(() => {
    measurementCancelRef.current?.()
    measurementCancelRef.current = null
    if (!props.active || !props.ready) {
      snapshotRef.current = null
      navigationRef.current = []
      setContent(emptyMinimapContent)
      return
    }
    const rail = railRef.current
    const scroller = props.scrollerRef.current
    const article = props.articleRef.current
    if (!rail || !scroller || !article) return
    const measure = (): void => {
      const key: MinimapSnapshotKey = {
        article,
        visualRevision: props.visualRevision,
        width: article.getBoundingClientRect().width,
        railWidth: rail.clientWidth,
        railHeight: rail.clientHeight,
        viewportHeight: scroller.clientHeight
      }
      if (key.railWidth <= 0 || key.railHeight <= 0) {
        measurementCancelRef.current = null
        return
      }
      if (
        snapshotRef.current?.article === article &&
        snapshotRef.current.visualRevision === key.visualRevision
      ) {
        if (snapshotRef.current.width !== key.width) {
          resolveMarkdownLayout(article, () => {
            refreshNavigationAnchors(navigationRef.current, scroller)
          })
          snapshotRef.current = key
        }
        updateFrame()
        measurementCancelRef.current = null
        return
      }
      const startedAt = performance.now()
      const measured = resolveMarkdownLayout(article, () => {
        const captured = measureMarkdownMinimapContent(article, scroller, rail.clientWidth, rail.clientHeight, props.yellowHighlightRanges)
        navigationRef.current = measureNavigationAnchors(article, scroller)
        return captured
      })
      geometryRef.current = measured.geometry
      snapshotRef.current = key
      setContent(measured)
      recordReaderDuration('minimap-measure', startedAt)
      updateFrame()
      measurementCancelRef.current = null
    }
    // The first overview belongs to document preparation, not idle work after
    // revealing the reader. Subsequent resize indexing remains deferred.
    if (snapshotRef.current) {
      measurementCancelRef.current = scheduleIdleMeasurement(measure)
    } else {
      const frame = window.requestAnimationFrame(measure)
      measurementCancelRef.current = () => window.cancelAnimationFrame(frame)
    }
    return () => {
      measurementCancelRef.current?.()
      measurementCancelRef.current = null
    }
  }, [props.active, props.articleRef, props.layoutRevision, props.ready, props.scrollerRef, props.visualRevision, props.yellowHighlightRanges, updateFrame])

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

  React.useLayoutEffect(() => {
    if (props.active && props.ready && snapshotRef.current && content.geometry.railWidth > 0 && content.geometry.railHeight > 0) {
      onPreparedRef.current?.()
    }
  }, [content, props.active, props.ready])

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
    measurementCancelRef.current?.()
  }, [])

  const readDragMetrics = React.useCallback((): DragMetrics | null => {
    const rail = railRef.current
    const scroller = props.scrollerRef.current
    if (!rail || !scroller) return null
    updateFrame()
    const bounds = rail.getBoundingClientRect()
    return {
      railTop: bounds.top,
      railHeight: rail.clientHeight
    }
  }, [props.scrollerRef, updateFrame])

  const scrollToPointer = React.useCallback((clientY: number, cached = dragMetricsRef.current) => {
    const scroller = props.scrollerRef.current
    if (!scroller || !cached) return
    const pointerY = clamp(clientY - cached.railTop, 0, cached.railHeight)
    const sourceCenter = pointerY / Math.max(1, cached.railHeight) * geometryRef.current.documentHeight
    const liveCenter = mapMinimapOffset(sourceCenter, navigationRef.current, 'source')
    scroller.scrollTop = clamp(liveCenter - scroller.clientHeight / 2, 0, maximumScroll(scroller))
    updateFrame()
  }, [props.scrollerRef, updateFrame])

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
  }, [schedulePointerScroll])

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
    updateFrame()
    const top = heading.element
      ? heading.element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      : mapMinimapOffset(heading.documentTop, navigationRef.current, 'source')
    scrollScrollerTo(scroller, top - 16)
    scheduleFrameUpdate()
  }, [props.scrollerRef, scheduleFrameUpdate, updateFrame])

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
      onPointerUp={finishPointerDrag}
      onPointerCancel={finishPointerDrag}
      onLostPointerCapture={finishPointerDrag}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
    >
      <div ref={staticLayerRef} style={{ position: 'absolute', left: 0, top: 0, width: content.geometry.railWidth, height: content.geometry.railHeight, transformOrigin: '0 0' }}>
      <canvas ref={canvasRef} className="markdown-minimap-canvas" aria-hidden="true" />
      <div ref={formulaLayerRef} className="markdown-minimap-formulas" aria-hidden="true" />
      {content.headings.map((heading) => (
        <button
          key={heading.id}
          type="button"
          className={`markdown-minimap-heading heading-${heading.headingLevel}`}
          data-minimap-heading={heading.headingLevel}
          aria-label={`跳转到${heading.title}`}
          style={{ top: heading.top, left: heading.left, width: heading.width, height: heading.height }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => jumpToHeading(heading)}
        />
      ))}
      </div>
      <div ref={frameRef} className="markdown-minimap-frame" data-preview="false" aria-hidden="true" />
      <div ref={frameHitRef} className="markdown-minimap-frame-hit" aria-hidden="true" />
    </div>
  )
}
