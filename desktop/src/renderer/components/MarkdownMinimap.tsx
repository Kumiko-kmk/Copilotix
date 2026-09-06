import React from 'react'

const MINIMAP_FRAME_MIN_HEIGHT = 24
const MINIMAP_HEADING_INDENTS = [4, 10, 16, 22, 28, 34] as const
const MINIMAP_KEYBOARD_STEP = 48
const MINIMAP_CONTENT_WIDTH = 80

export interface MarkdownMinimapItem {
  id: string
  top: number
  height: number
  left: number
  width: number
  documentTop: number
  headingLevel: number | null
  title: string | null
}

export default function MarkdownMinimap(props: {
  active: boolean
  ready: boolean
  layoutRevision: number
  controlledId: string
  scrollerRef: React.RefObject<HTMLDivElement | null>
  articleRef: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const railRef = React.useRef<HTMLDivElement>(null)
  const frameRef = React.useRef<HTMLDivElement>(null)
  const frameRequestRef = React.useRef<number | null>(null)
  const draggingRef = React.useRef(false)
  const [items, setItems] = React.useState<MarkdownMinimapItem[]>([])

  const updateFrame = React.useCallback(() => {
    const rail = railRef.current
    const frame = frameRef.current
    const scroller = props.scrollerRef.current
    if (!rail || !frame || !scroller) return
    const metrics = minimapFrameMetrics(scroller, rail.clientHeight)
    frame.style.setProperty('--markdown-minimap-frame-top', `${metrics.top}px`)
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
      setItems([])
      return
    }
    const rail = railRef.current
    const scroller = props.scrollerRef.current
    const article = props.articleRef.current
    if (!rail || !scroller || !article) return
    setItems(measureMarkdownMinimapItems(article, scroller, rail.clientHeight))
    updateFrame()
  }, [props.active, props.articleRef, props.layoutRevision, props.ready, props.scrollerRef, updateFrame])

  React.useEffect(() => {
    if (!props.active || !props.ready) return
    const scroller = props.scrollerRef.current
    if (!scroller) return
    scroller.addEventListener('scroll', scheduleFrameUpdate, { passive: true })
    return () => scroller.removeEventListener('scroll', scheduleFrameUpdate)
  }, [props.active, props.ready, props.scrollerRef, scheduleFrameUpdate])

  React.useLayoutEffect(() => {
    updateFrame()
  }, [items, updateFrame])

  React.useEffect(() => () => {
    if (frameRequestRef.current !== null) window.cancelAnimationFrame(frameRequestRef.current)
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
    frame.style.setProperty('--markdown-minimap-frame-top', `${top}px`)
    frame.style.setProperty('--markdown-minimap-frame-height', `${metrics.height}px`)
    frame.dataset.preview = 'true'
  }, [props.scrollerRef])

  const scrollToPointer = React.useCallback((clientY: number) => {
    const rail = railRef.current
    const scroller = props.scrollerRef.current
    if (!rail || !scroller) return
    const bounds = rail.getBoundingClientRect()
    const metrics = minimapFrameMetrics(scroller, rail.clientHeight)
    const pointerY = clamp(clientY - bounds.top, 0, rail.clientHeight)
    const frameTravel = Math.max(0, rail.clientHeight - metrics.height)
    const targetFrameTop = clamp(pointerY - metrics.height / 2, 0, frameTravel)
    scroller.scrollTop = frameTravel > 0 ? targetFrameTop / frameTravel * metrics.maxScroll : 0
    scheduleFrameUpdate()
  }, [props.scrollerRef, scheduleFrameUpdate])

  const onPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-minimap-heading]')) return
    event.preventDefault()
    event.currentTarget.focus()
    draggingRef.current = true
    event.currentTarget.setPointerCapture?.(event.pointerId)
    scrollToPointer(event.clientY)
  }, [scrollToPointer])

  const onPointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) scrollToPointer(event.clientY)
    else previewAtPointer(event.clientY)
  }, [previewAtPointer, scrollToPointer])

  const finishPointerDrag = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    updateFrame()
  }, [updateFrame])

  const onWheel = React.useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const scroller = props.scrollerRef.current
    if (!scroller) return
    event.preventDefault()
    setScrollerTop(scroller, scroller.scrollTop + event.deltaY + event.deltaX)
    scheduleFrameUpdate()
  }, [props.scrollerRef, scheduleFrameUpdate])

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

  const jumpToHeading = React.useCallback((item: MarkdownMinimapItem) => {
    const scroller = props.scrollerRef.current
    if (!scroller) return
    scrollScrollerTo(scroller, item.documentTop - 16)
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
      onPointerLeave={() => {
        if (!draggingRef.current) updateFrame()
      }}
      onPointerUp={finishPointerDrag}
      onPointerCancel={finishPointerDrag}
      onLostPointerCapture={finishPointerDrag}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
    >
      <div className="markdown-minimap-content" aria-hidden="true">
        {items.filter((item) => item.headingLevel === null).map((item) => (
          <span
            key={item.id}
            className="markdown-minimap-line"
            style={{ top: item.top, left: item.left, width: item.width, height: item.height }}
          />
        ))}
      </div>
      {items.filter((item) => item.headingLevel !== null).map((item) => (
        <button
          key={item.id}
          type="button"
          className={`markdown-minimap-heading heading-${item.headingLevel}`}
          data-minimap-heading={item.headingLevel}
          title={item.title ?? undefined}
          aria-label={`跳转到${item.title ?? '章节标题'}`}
          style={{ top: item.top, left: item.left, width: item.width, height: item.height }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => jumpToHeading(item)}
        >
          {item.title}
        </button>
      ))}
      <div ref={frameRef} className="markdown-minimap-frame" data-preview="false" aria-hidden="true" />
    </div>
  )
}

export function measureMarkdownMinimapItems(
  article: HTMLElement,
  scroller: HTMLElement,
  railHeight: number
): MarkdownMinimapItem[] {
  if (railHeight <= 0 || scroller.scrollHeight <= 0) return []
  const scrollerBounds = scroller.getBoundingClientRect()
  const candidates: HTMLElement[] = []
  for (const wrapper of Array.from(article.children)) {
    if (!(wrapper instanceof HTMLElement)) continue
    if (wrapper.classList.contains('markdown-block')) {
      const children = Array.from(wrapper.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
      candidates.push(...(children.length > 0 ? children : [wrapper]))
    } else {
      candidates.push(wrapper)
    }
  }

  return candidates.map((element, index) => {
    const bounds = element.getBoundingClientRect()
    const documentTop = bounds.top - scrollerBounds.top + scroller.scrollTop
    const headingLevel = headingLevelOf(element)
    const title = headingLevel === null ? null : normalizeMinimapTitle(element.textContent)
    const top = clamp(documentTop / scroller.scrollHeight * railHeight, 0, railHeight)
    const height = headingLevel === null
      ? clamp(bounds.height / scroller.scrollHeight * railHeight, 2, 7)
      : 10
    const left = headingLevel === null ? 5 : MINIMAP_HEADING_INDENTS[headingLevel - 1] ?? 34
    const availableWidth = Math.max(8, MINIMAP_CONTENT_WIDTH - left)
    const width = headingLevel === null
      ? Math.min(availableWidth, Math.max(18, 14 + Math.sqrt((element.textContent ?? '').trim().length) * 5))
      : availableWidth
    return {
      id: `minimap-${index}`,
      top: clamp(top, 0, Math.max(0, railHeight - height)),
      height,
      left,
      width,
      documentTop,
      headingLevel,
      title
    }
  })
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
