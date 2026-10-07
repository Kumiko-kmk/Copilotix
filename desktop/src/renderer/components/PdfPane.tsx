import React from 'react'
import { LeftOutlined, MinusOutlined, PlusOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons'
import { Alert, Button, Progress, Space } from 'antd'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { BlockBox, BlockMapping, BlockSelection } from '@shared/types'
import { acquirePdfDocument } from '../pdfDocumentCache'
import { pdfPageRenderScheduler, type ScheduledPdfRender } from '../pdfRenderScheduler'
import { recordReaderDuration } from '../readerPerformance'

type LoadingState =
  | { status: 'loading'; progress: number | null }
  | { status: 'ready' }
  | { status: 'error'; message: string }

const PAGE_RENDER_RADIUS = 1
const PDF_PAGE_GAP = 24
const PDF_VIEWPORT_FOCUS = 0.45
const PDF_MAX_CANVAS_PIXELS = 8 * 1024 * 1024
const PDF_MAX_CANVAS_DIMENSION = 8192
const SCROLLBAR_HOT_ZONE_PX = 16
const SCROLLBAR_HIDE_DELAY_MS = 300

interface ScrollbarVisibility {
  horizontal: boolean
  vertical: boolean
}

const HIDDEN_SCROLLBARS: ScrollbarVisibility = { horizontal: false, vertical: false }

export default function PdfPane(props: {
  url: string
  mappings: BlockMapping[]
  selection: BlockSelection | null
  onSelect(selection: BlockSelection): void
}): React.JSX.Element {
  const [document, setDocument] = React.useState<PDFDocumentProxy | null>(null)
  const [loadingState, setLoadingState] = React.useState<LoadingState>({ status: 'loading', progress: null })
  const [currentPage, setCurrentPage] = React.useState(1)
  const [zoom, setZoom] = React.useState(1)
  const [contentWidth, setContentWidth] = React.useState(0)
  const [pageSizes, setPageSizes] = React.useState<readonly PdfBaseSize[]>([])
  const [reloadKey, setReloadKey] = React.useState(0)
  const [scrollbars, setScrollbars] = React.useState<ScrollbarVisibility>(HIDDEN_SCROLLBARS)
  const scrollerRef = React.useRef<HTMLDivElement>(null)
  const scrollbarHideTimerRef = React.useRef<number | null>(null)
  const scrollbarDraggingRef = React.useRef(false)
  const scrollFrameRef = React.useRef<number | null>(null)
  const mappingsByPage = React.useMemo(() => indexMappingsByPage(props.mappings, document?.numPages ?? 0), [document?.numPages, props.mappings])
  const pageLayout = React.useMemo(() => buildPdfPageLayout(pageSizes, contentWidth, zoom), [contentWidth, pageSizes, zoom])
  const pageLayoutRef = React.useRef(pageLayout)
  const layoutDocumentRef = React.useRef(document)
  const scrollAnchorRef = React.useRef<PdfScrollAnchor | null>(null)
  const renderWindow = pdfRenderWindow(currentPage - 1, pageSizes.length, PAGE_RENDER_RADIUS)

  const cancelScrollbarHide = React.useCallback(() => {
    if (scrollbarHideTimerRef.current === null) return
    window.clearTimeout(scrollbarHideTimerRef.current)
    scrollbarHideTimerRef.current = null
  }, [])

  const hideScrollbars = React.useCallback(() => {
    setScrollbars((current) => current.horizontal || current.vertical ? HIDDEN_SCROLLBARS : current)
  }, [])

  const scheduleScrollbarHide = React.useCallback(() => {
    if (scrollbarDraggingRef.current || scrollbarHideTimerRef.current !== null) return
    scrollbarHideTimerRef.current = window.setTimeout(() => {
      scrollbarHideTimerRef.current = null
      hideScrollbars()
    }, SCROLLBAR_HIDE_DELAY_MS)
  }, [hideScrollbars])

  const revealScrollbarsNearEdge = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (scrollbarDraggingRef.current) return
    const scroller = scrollerRef.current
    if (!scroller) return
    const bounds = scroller.getBoundingClientRect()
    const hasHorizontalOverflow = scroller.scrollWidth > scroller.clientWidth
    const hasVerticalOverflow = scroller.scrollHeight > scroller.clientHeight
    if (!hasHorizontalOverflow && !hasVerticalOverflow) {
      cancelScrollbarHide()
      hideScrollbars()
      return
    }
    const nearRight = bounds.right - event.clientX >= 0 && bounds.right - event.clientX <= SCROLLBAR_HOT_ZONE_PX
    const nearBottom = bounds.bottom - event.clientY >= 0 && bounds.bottom - event.clientY <= SCROLLBAR_HOT_ZONE_PX
    const next: ScrollbarVisibility = {
      horizontal: nearBottom && hasHorizontalOverflow,
      vertical: nearRight && hasVerticalOverflow
    }
    if (!next.horizontal && !next.vertical) {
      scheduleScrollbarHide()
      return
    }
    cancelScrollbarHide()
    setScrollbars((current) => current.horizontal === next.horizontal && current.vertical === next.vertical ? current : next)
  }, [cancelScrollbarHide, hideScrollbars, scheduleScrollbarHide])

  const startScrollbarDrag = React.useCallback(() => {
    if (!scrollbars.horizontal && !scrollbars.vertical) return
    cancelScrollbarHide()
    scrollbarDraggingRef.current = true
  }, [cancelScrollbarHide, scrollbars.horizontal, scrollbars.vertical])

  const finishScrollbarDrag = React.useCallback(() => {
    if (!scrollbarDraggingRef.current) return
    scrollbarDraggingRef.current = false
    scheduleScrollbarHide()
  }, [scheduleScrollbarHide])

  React.useEffect(() => {
    window.addEventListener('pointerup', finishScrollbarDrag)
    window.addEventListener('pointercancel', finishScrollbarDrag)
    return () => {
      window.removeEventListener('pointerup', finishScrollbarDrag)
      window.removeEventListener('pointercancel', finishScrollbarDrag)
      cancelScrollbarHide()
    }
  }, [cancelScrollbarHide, finishScrollbarDrag])

  React.useEffect(() => {
    let cancelled = false
    const handle = acquirePdfDocument(props.url, {
      onProgress: ({ loaded, total }) => {
        if (!cancelled) setLoadingState({ status: 'loading', progress: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null })
      },
      onPassword: () => {
        if (!cancelled) setLoadingState({ status: 'error', message: '该 PDF 受密码保护，当前阅读器无法打开。' })
      }
    })
    setDocument(null)
    setLoadingState({ status: 'loading', progress: null })
    void handle.promise
      .then((value) => {
        if (cancelled) return
        setDocument(value)
        setCurrentPage(1)
        setPageSizes(Array.from({ length: value.numPages }, () => DEFAULT_PDF_PAGE_SIZE))
        setLoadingState({ status: 'ready' })
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadingState({ status: 'error', message: pdfErrorMessage(error) })
      })
    return () => {
      cancelled = true
      handle.release()
    }
  }, [props.url, reloadKey])

  React.useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
  }, [])

  React.useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const measure = (): void => {
      const next = readPdfContentWidth(scroller)
      setContentWidth((current) => current === next ? current : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [])

  React.useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const documentChanged = layoutDocumentRef.current !== document
    const layoutChanged = pageLayoutRef.current !== pageLayout
    pageLayoutRef.current = pageLayout
    layoutDocumentRef.current = document
    if (documentChanged || layoutChanged) {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current)
        scrollFrameRef.current = null
      }
      // Preserve a PDF point, rather than interpreting the old pixel offset
      // against resized pages. Instant scrolling also stops stale smooth motion.
      if (documentChanged) {
        scroller.scrollTo({ top: 0, left: 0, behavior: 'instant' })
      } else if (scrollAnchorRef.current) {
        scroller.scrollTo({
          top: pdfScrollTopForAnchor(pageLayout, scrollAnchorRef.current, scroller.clientHeight),
          behavior: 'instant'
        })
      }
    }
    scrollAnchorRef.current = capturePdfScrollAnchor(pageLayout, scroller.scrollTop, scroller.clientHeight)
  }, [document, pageLayout])

  React.useEffect(() => {
    const selection = props.selection
    if (!selection || (selection.origin !== 'markdown' && selection.origin !== 'citation')) return
    const mapping = props.mappings.find((item) => item.id === selection.mappingId)
    const targetBox = mapping ? findTargetBox(mapping, selection.blockPosition) : undefined
    const pageIndex = targetBox?.pageIndex
    if (!mapping || !targetBox || pageIndex === undefined) return
    scrollAnchorRef.current = {
      pageIndex,
      pageFraction: (targetBox.bbox[1] + targetBox.bbox[3]) / (2 * targetBox.pageSize[1]),
      viewportFraction: 0.5
    }
    setCurrentPage(pageIndex + 1)
    requestAnimationFrame(() => {
      const page = scrollerRef.current?.querySelector<HTMLElement>(`[data-pdf-page="${pageIndex}"]`)
      if (!page) return
      const target = Array.from(page.querySelectorAll<HTMLElement>('[data-block-id]')).find(
        (element) => element.dataset.blockId === mapping.id && element.dataset.blockPosition === targetBox.blockPosition
      )
      const destination = target ?? page
      destination.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
    })
  }, [props.mappings, props.selection])

  const goToPage = React.useCallback((page: number) => {
    if (!document) return
    const next = Math.max(1, Math.min(document.numPages, page))
    scrollAnchorRef.current = { pageIndex: next - 1, pageFraction: 0, viewportFraction: 0 }
    setCurrentPage(next)
    requestAnimationFrame(() => {
      scrollerRef.current?.querySelector<HTMLElement>(`[data-pdf-page="${next - 1}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [document])

  const onPageSize = React.useCallback((pageIndex: number, size: PdfBaseSize) => {
    setPageSizes((current) => {
      const existing = current[pageIndex]
      if (existing && existing.width === size.width && existing.height === size.height) return current
      const next = [...current]
      next[pageIndex] = size
      return next
    })
  }, [])
  const onPdfScroll = React.useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    // Capture immediately: a queued scroll frame can be overtaken by resizing.
    scrollAnchorRef.current = capturePdfScrollAnchor(pageLayoutRef.current, scroller.scrollTop, scroller.clientHeight)
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null
      const scroller = scrollerRef.current
      if (!scroller || pageLayoutRef.current.pages.length === 0) return
      const pageIndex = pageIndexAtOffset(pageLayoutRef.current, scroller.scrollTop + scroller.clientHeight * PDF_VIEWPORT_FOCUS)
      setCurrentPage((current) => current === pageIndex + 1 ? current : pageIndex + 1)
    })
  }, [])
  const retry = React.useCallback(() => setReloadKey((value) => value + 1), [])
  const onPageError = React.useCallback((message: string) => setLoadingState({ status: 'error', message }), [])
  const onPdfBlock = React.useCallback((mappingId: string, blockPosition: string) => {
    props.onSelect({ mappingId, blockPosition, origin: 'pdf' })
  }, [props.onSelect])

  return (
    <div className="pdf-pane">
      <div className="pdf-toolbar">
        <strong>原文件</strong>
        <Space size="small">
          <Button disabled={!document} type="text" icon={<LeftOutlined />} onClick={() => goToPage(currentPage - 1)} aria-label="上一页" />
          <span>{currentPage} / {document?.numPages ?? '-'}</span>
          <Button disabled={!document} type="text" icon={<RightOutlined />} onClick={() => goToPage(currentPage + 1)} aria-label="下一页" />
          <Button disabled={!document} type="text" icon={<MinusOutlined />} onClick={() => setZoom((value) => Math.max(0.6, value - 0.1))} aria-label="缩小" />
          <span>{Math.round(zoom * 100)}%</span>
          <Button disabled={!document} type="text" icon={<PlusOutlined />} onClick={() => setZoom((value) => Math.min(2, value + 0.1))} aria-label="放大" />
        </Space>
      </div>
      <div
        className={`pdf-scroll${scrollbars.vertical ? ' pdf-scrollbar-y-visible' : ''}${scrollbars.horizontal ? ' pdf-scrollbar-x-visible' : ''}`}
        ref={scrollerRef}
        aria-live="polite"
        onPointerMove={revealScrollbarsNearEdge}
        onPointerLeave={scheduleScrollbarHide}
        onPointerDown={startScrollbarDrag}
        onScroll={onPdfScroll}
      >
        {loadingState.status === 'loading' ? (
          <div className="pdf-loading">
            <span>正在加载 PDF…</span>
            {loadingState.progress === null ? null : <Progress percent={loadingState.progress} size="small" />}
          </div>
        ) : null}
        {loadingState.status === 'error' ? (
          <Alert
            className="pdf-error"
            type="error"
            showIcon
            message="PDF 无法打开"
            description={loadingState.message}
            action={<Button icon={<ReloadOutlined />} onClick={retry}>重新加载</Button>}
          />
        ) : null}
        {document && loadingState.status === 'ready'
          ? <>
            {renderWindow.start > 0 ? <div className="pdf-page-spacer" style={{ height: pageLayout.pages[renderWindow.start]?.top ?? 0 }} aria-hidden="true" /> : null}
            {Array.from({ length: renderWindow.end - renderWindow.start }, (_, offset) => {
              const pageIndex = renderWindow.start + offset
              const baseSize = pageSizes[pageIndex] ?? DEFAULT_PDF_PAGE_SIZE
              return (
            <PdfPage
              key={pageIndex}
              document={document}
              pageIndex={pageIndex}
              renderPriority={Math.abs(pageIndex - (currentPage - 1))}
              zoom={zoom}
              contentWidth={contentWidth}
              baseSize={baseSize}
              mappings={mappingsByPage[pageIndex] ?? EMPTY_PAGE_MAPPINGS}
              selection={props.selection}
              onSelect={onPdfBlock}
              onPageSize={onPageSize}
              onError={onPageError}
            />
              )
            })}
            {renderWindow.end < pageSizes.length ? <div className="pdf-page-spacer" style={{ height: remainingPdfLayoutHeight(pageLayout, renderWindow.end) }} aria-hidden="true" /> : null}
          </>
          : null}
      </div>
    </div>
  )
}

const PdfPage = React.memo(function PdfPage(props: {
  document: PDFDocumentProxy
  pageIndex: number
  renderPriority: number
  zoom: number
  contentWidth: number
  baseSize: PdfBaseSize
  mappings: BlockMapping[]
  selection: BlockSelection | null
  onSelect(mappingId: string, blockPosition: string): void
  onPageSize(pageIndex: number, size: PdfBaseSize): void
  onError(message: string): void
}): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const pageRef = React.useRef<HTMLDivElement>(null)
  const renderTaskRef = React.useRef<ScheduledPdfRender | null>(null)
  const [page, setPage] = React.useState<PDFPageProxy | null>(null)
  const { scale, width, height } = pdfPageMetrics(props.baseSize, props.contentWidth, props.zoom)
  const size = { width, height }

  React.useEffect(() => {
    let cancelled = false
    let loadedPage: PDFPageProxy | null = null
    void props.document.getPage(props.pageIndex + 1)
      .then((value) => {
        if (cancelled) {
          value.cleanup()
          return
        }
        const viewport = value.getViewport({ scale: 1 })
        loadedPage = value
        props.onPageSize(props.pageIndex, { width: viewport.width, height: viewport.height })
        setPage(value)
      })
      .catch((error: unknown) => { if (!cancelled) props.onError(pdfErrorMessage(error)) })
    return () => {
      cancelled = true
      const render = renderTaskRef.current
      if (render) {
        render.cancel()
        void render.promise.catch(() => undefined).finally(() => loadedPage?.cleanup())
      } else {
        loadedPage?.cleanup()
      }
    }
  }, [props.document, props.onError, props.onPageSize, props.pageIndex])

  React.useEffect(() => {
    if (!page || !canvasRef.current) return
    const viewport = page.getViewport({ scale })
    const canvas = canvasRef.current
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`
    const output = pdfCanvasOutput(viewport.width, viewport.height, window.devicePixelRatio || 1)
    const renderStartedAt = performance.now()
    const renderTask = pdfPageRenderScheduler.schedule(canvas, props.renderPriority, () => {
      canvas.width = output.width
      canvas.height = output.height
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('无法创建 PDF 页面画布，请降低缩放比例后重试。')
      return page.render({
        canvas,
        canvasContext: context,
        viewport,
        background: 'rgb(255,255,255)',
        transform: output.scale === 1 ? undefined : [output.scale, 0, 0, output.scale, 0, 0]
      })
    })
    renderTaskRef.current = renderTask
    void renderTask.promise
      .then(() => recordReaderDuration('pdf-render', renderStartedAt))
      .catch((error: unknown) => {
        if (!isRenderingCancelled(error)) props.onError(pdfErrorMessage(error))
      })
    return () => {
      renderTask.cancel()
      renderTaskRef.current = null
    }
  }, [page, props.onError, scale])

  React.useEffect(() => {
    renderTaskRef.current?.setPriority(props.renderPriority)
  }, [props.renderPriority])

  const overlays = React.useMemo(
    () => props.mappings.flatMap((mapping) => mapping.boxes
      .filter((box) => box.pageIndex === props.pageIndex)
      .map((box) => ({ mapping, box }))),
    [props.mappings, props.pageIndex]
  )
  const connectors = React.useMemo(
    () => buildMergeConnectors(props.mappings, props.pageIndex, size),
    [props.mappings, props.pageIndex, size.height, size.width]
  )

  return (
    <div className="pdf-page" data-pdf-page={props.pageIndex} ref={pageRef} style={size}>
      <canvas ref={canvasRef} />
      <div className="pdf-overlay-layer">
        <svg className="pdf-merge-layer" viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true">
          {connectors.map((connector) => (
            <g key={connector.key}>
              <line x1={connector.x1} y1={connector.y1} x2={connector.x2} y2={connector.y2} />
              <text x={(connector.x1 + connector.x2) / 2} y={(connector.y1 + connector.y2) / 2 - 5}>合并</text>
            </g>
          ))}
        </svg>
        {overlays.map(({ mapping, box }) => {
          const [pageWidth, pageHeight] = box.pageSize
          const [x0, y0, x1, y1] = box.bbox
          return (
            <button
              key={`${mapping.id}-${box.blockPosition}`}
              className={[
                'pdf-block',
                props.selection?.mappingId === mapping.id ? 'active' : '',
                box.isDiscarded ? 'discarded' : '',
                box.mergeRole ? 'merged' : ''
              ].filter(Boolean).join(' ')}
              data-block-id={mapping.id}
              data-block-position={box.blockPosition}
              style={{
                left: `${(x0 / pageWidth) * 100}%`,
                top: `${(y0 / pageHeight) * 100}%`,
                width: `${((x1 - x0) / pageWidth) * 100}%`,
                height: `${((y1 - y0) / pageHeight) * 100}%`
              }}
              onClick={() => props.onSelect(mapping.id, box.blockPosition)}
              aria-label={`${blockTypeLabel(mapping.type)}区块 ${mapping.order + 1}${box.mergeRole === 'continuation' ? '（合并续块）' : ''}`}
            >
              <span className="pdf-block-label">{blockTypeLabel(mapping.type)}</span>
              {box.mergeRole === 'continuation' ? <span className="pdf-merge-badge">合并</span> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
})

const DEFAULT_PDF_PAGE_SIZE: PdfBaseSize = Object.freeze({ width: 612, height: 792 })
const EMPTY_PAGE_MAPPINGS: BlockMapping[] = []

interface PdfBaseSize {
  width: number
  height: number
}

export function indexMappingsByPage(mappings: BlockMapping[], pageCount: number): BlockMapping[][] {
  const pages = Array.from({ length: pageCount }, () => [] as BlockMapping[])
  for (const mapping of mappings) {
    const seen = new Set<number>()
    for (const box of mapping.boxes) {
      if (box.pageIndex < 0 || box.pageIndex >= pageCount || seen.has(box.pageIndex)) continue
      pages[box.pageIndex]?.push(mapping)
      seen.add(box.pageIndex)
    }
  }
  return pages
}

export interface PdfPageLayout {
  pages: Array<{ top: number; width: number; height: number }>
  totalHeight: number
}

export interface PdfScrollAnchor {
  pageIndex: number
  pageFraction: number
  viewportFraction: number
}

export function capturePdfScrollAnchor(layout: PdfPageLayout, scrollTop: number, viewportHeight: number): PdfScrollAnchor | null {
  const focusOffset = scrollTop + viewportHeight * PDF_VIEWPORT_FOCUS
  const pageIndex = pageIndexAtOffset(layout, focusOffset)
  const page = layout.pages[pageIndex]
  if (!page) return null
  return {
    pageIndex,
    pageFraction: Math.max(0, Math.min(1, (focusOffset - page.top) / page.height)),
    viewportFraction: PDF_VIEWPORT_FOCUS
  }
}

export function pdfScrollTopForAnchor(layout: PdfPageLayout, anchor: PdfScrollAnchor, viewportHeight: number): number {
  const page = layout.pages[anchor.pageIndex]
  if (!page) return 0
  const requested = page.top + page.height * anchor.pageFraction - viewportHeight * anchor.viewportFraction
  return Math.max(0, Math.min(Math.max(0, layout.totalHeight - viewportHeight), requested))
}

export function buildPdfPageLayout(
  pageSizes: readonly PdfBaseSize[],
  contentWidth: number,
  zoom: number
): PdfPageLayout {
  let consumed = 0
  const pages = pageSizes.map((size) => {
    const top = consumed
    const metrics = pdfPageMetrics(size, contentWidth, zoom)
    consumed += metrics.height + PDF_PAGE_GAP
    return { top, width: metrics.width, height: metrics.height }
  })
  return { pages, totalHeight: consumed }
}

export function pageIndexAtOffset(layout: PdfPageLayout, offset: number): number {
  if (layout.pages.length === 0) return 0
  let low = 0
  let high = layout.pages.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((layout.pages[middle]?.top ?? 0) <= offset) low = middle + 1
    else high = middle
  }
  if (low >= layout.pages.length) return layout.pages.length - 1
  return Math.max(0, low - 1)
}

export function pdfRenderWindow(currentPageIndex: number, pageCount: number, radius: number): { start: number; end: number } {
  const safeCurrent = Math.min(Math.max(0, currentPageIndex), Math.max(0, pageCount - 1))
  return {
    start: Math.max(0, safeCurrent - radius),
    end: Math.min(pageCount, safeCurrent + radius + 1)
  }
}

function remainingPdfLayoutHeight(layout: PdfPageLayout, firstHiddenPage: number): number {
  return Math.max(0, layout.totalHeight - (layout.pages[firstHiddenPage]?.top ?? layout.totalHeight))
}

function findTargetBox(mapping: BlockMapping, blockPosition?: string): BlockBox | undefined {
  return (
    (blockPosition ? mapping.boxes.find((box) => box.blockPosition === blockPosition) : undefined) ??
    mapping.boxes.find((box) => box.mergeRole === 'source') ??
    mapping.boxes[0]
  )
}

export function pdfPageMetrics(
  baseSize: { width: number; height: number },
  contentWidth: number,
  zoom: number
): { scale: number; width: number; height: number } {
  const safeWidth = Number.isFinite(contentWidth) && contentWidth > 0 ? contentWidth : baseSize.width
  const safeZoom = Number.isFinite(zoom) ? Math.min(2, Math.max(0.6, zoom)) : 1
  const scale = baseSize.width > 0 ? safeWidth / baseSize.width * safeZoom : safeZoom
  return { scale, width: baseSize.width * scale, height: baseSize.height * scale }
}

export function pdfCanvasOutput(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number
): { width: number; height: number; scale: number } {
  const safeWidth = Math.max(1, Number.isFinite(cssWidth) ? cssWidth : 1)
  const safeHeight = Math.max(1, Number.isFinite(cssHeight) ? cssHeight : 1)
  const safeDeviceScale = Math.max(1, Math.min(2, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1))
  const dimensionScale = Math.min(PDF_MAX_CANVAS_DIMENSION / safeWidth, PDF_MAX_CANVAS_DIMENSION / safeHeight)
  const pixelScale = Math.sqrt(PDF_MAX_CANVAS_PIXELS / (safeWidth * safeHeight))
  const scale = Math.max(Number.EPSILON, Math.min(safeDeviceScale, dimensionScale, pixelScale))
  return {
    width: Math.max(1, Math.floor(safeWidth * scale)),
    height: Math.max(1, Math.floor(safeHeight * scale)),
    scale
  }
}

export function readPdfContentWidth(scroller: HTMLElement): number {
  const style = window.getComputedStyle(scroller)
  const padding = numericPixels(style.paddingLeft) + numericPixels(style.paddingRight)
  return Math.max(0, scroller.clientWidth - padding)
}

function numericPixels(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

interface MergeConnector {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
}

function buildMergeConnectors(
  mappings: BlockMapping[],
  pageIndex: number,
  size: { width: number; height: number }
): MergeConnector[] {
  const connectors: MergeConnector[] = []
  for (const mapping of mappings) {
    if (mapping.boxes.length < 2) continue
    for (let index = 0; index < mapping.boxes.length - 1; index += 1) {
      const source = mapping.boxes[index]
      const target = mapping.boxes[index + 1]
      if (!source || !target) continue
      if (source.pageIndex === pageIndex && target.pageIndex === pageIndex) {
        const points = closestConnection(normalizeBox(source, size), normalizeBox(target, size))
        connectors.push({ key: `${mapping.id}-${index}`, ...points })
      } else if (source.pageIndex === pageIndex && target.pageIndex > pageIndex) {
        const box = normalizeBox(source, size)
        connectors.push({
          key: `${mapping.id}-${index}-out`,
          x1: (box.left + box.right) / 2,
          y1: box.bottom,
          x2: (box.left + box.right) / 2,
          y2: size.height
        })
      } else if (target.pageIndex === pageIndex && source.pageIndex < pageIndex) {
        const box = normalizeBox(target, size)
        connectors.push({
          key: `${mapping.id}-${index}-in`,
          x1: (box.left + box.right) / 2,
          y1: 0,
          x2: (box.left + box.right) / 2,
          y2: box.top
        })
      }
    }
  }
  return connectors
}

function normalizeBox(box: BlockBox, size: { width: number; height: number }): { left: number; top: number; right: number; bottom: number } {
  const [pageWidth, pageHeight] = box.pageSize
  return {
    left: (box.bbox[0] / pageWidth) * size.width,
    top: (box.bbox[1] / pageHeight) * size.height,
    right: (box.bbox[2] / pageWidth) * size.width,
    bottom: (box.bbox[3] / pageHeight) * size.height
  }
}

function closestConnection(
  source: { left: number; top: number; right: number; bottom: number },
  target: { left: number; top: number; right: number; bottom: number }
): Omit<MergeConnector, 'key'> {
  const sourceCenter = { x: (source.left + source.right) / 2, y: (source.top + source.bottom) / 2 }
  const targetCenter = { x: (target.left + target.right) / 2, y: (target.top + target.bottom) / 2 }
  if (Math.abs(targetCenter.x - sourceCenter.x) > Math.abs(targetCenter.y - sourceCenter.y)) {
    return targetCenter.x >= sourceCenter.x
      ? { x1: source.right, y1: sourceCenter.y, x2: target.left, y2: targetCenter.y }
      : { x1: source.left, y1: sourceCenter.y, x2: target.right, y2: targetCenter.y }
  }
  return targetCenter.y >= sourceCenter.y
    ? { x1: sourceCenter.x, y1: source.bottom, x2: targetCenter.x, y2: target.top }
    : { x1: sourceCenter.x, y1: source.top, x2: targetCenter.x, y2: target.bottom }
}

function blockTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    text: '文本',
    ref_text: '文本',
    title: '标题',
    image: '图片',
    chart: '图表',
    table: '表格',
    interline_equation: '公式',
    equation: '公式',
    page_header: '页眉',
    header: '页眉',
    page_footer: '页脚',
    footer: '页脚',
    page_footnote: '脚注',
    page_number: '页码'
  }
  return labels[type] ?? '区块'
}

function pdfErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (error.name === 'InvalidPDFException') return 'PDF 文件已损坏或格式无效。'
  if (error.name === 'MissingPDFException') return '本地 PDF 文件不存在。'
  if (error.name === 'PasswordException') return '该 PDF 受密码保护，当前阅读器无法打开。'
  if (error.name === 'UnexpectedResponseException') return '读取本地 PDF 时返回了异常响应，请重试。'
  return error.message || '加载 PDF 时发生未知错误。'
}

function isRenderingCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException'
}
