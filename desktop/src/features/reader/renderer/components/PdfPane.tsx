import React from 'react'
import { createPortal } from 'react-dom'
import BlockContextMenu, { type BlockMenuItem } from './BlockContextMenu'
import { LeftOutlined, MinusOutlined, PlusOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons'
import { Alert, Button, Progress, Space } from 'antd'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { BlockMapping } from '@features/parsing/contract/blocks'
import type { BlockSelection } from '../../contract/readerTypes'
import { acquirePdfDocument } from '@platform/pdf/renderer/pdfDocumentCache'
import { SYNC_READING_LINE, trackScrollIntent, type ScrollIntent, type ScrollSyncChannel } from '../readerScrollSync'
import { DEFAULT_PDF_PAGE_SIZE, EMPTY_PAGE_MAPPINGS, indexMappingsByPage, capturePdfScrollAnchor, pdfScrollTopForAnchor, buildPdfPageLayout, pageIndexAtOffset, pdfRenderWindow, remainingPdfLayoutHeight, pdfSyncPosition, findTargetBox, readPdfContentWidth, pdfErrorMessage, type PdfBaseSize, type PdfScrollAnchor, PDF_VIEWPORT_FOCUS, type ScrollMetrics } from './pdfLayout'
import { PdfScrollbar, PdfPage } from './PdfPageView'

export { indexMappingsByPage, capturePdfScrollAnchor, pdfScrollTopForAnchor, buildPdfPageLayout, pageIndexAtOffset, pdfRenderWindow, pdfSyncPosition, pdfPageMetrics, pdfCanvasOutput, readPdfContentWidth } from './pdfLayout'
export type { PdfPageLayout, PdfScrollAnchor } from './pdfLayout'

type LoadingState =
  | { status: 'loading'; progress: number | null }
  | { status: 'ready' }
  | { status: 'error'; message: string }

const PAGE_RENDER_RADIUS = 1
const SCROLLBAR_HOT_ZONE_PX = 16
const SCROLLBAR_HIDE_DELAY_MS = 300

interface ScrollbarVisibility {
  horizontal: boolean
  vertical: boolean
}

const HIDDEN_SCROLLBARS: ScrollbarVisibility = { horizontal: false, vertical: false }
const EMPTY_SCROLL_METRICS: ScrollMetrics = { width: 0, height: 0, contentWidth: 0, contentHeight: 0, left: 0, top: 0 }

/** Reading position and zoom, so a remounted pane (moved or reopened) resumes where it was. */
export interface PdfViewState {
  zoom: number
  anchor: PdfScrollAnchor | null
}

export type PdfBlockMenuItem = BlockMenuItem
/** Right-click menu on a layout block; the reader decides the items and acts on the choice. */
export interface PdfBlockMenu {
  boxed: ReadonlySet<string>
  deleted: ReadonlySet<string>
  items(mappingId: string): PdfBlockMenuItem[]
  onSelect(key: string, mappingId: string): void
}

export default function PdfPane(props: {
  url: string
  mappings: BlockMapping[]
  selection: BlockSelection | null
  onSelect(selection: BlockSelection): void
  /**
   * When set, page and zoom controls render into this element (a workbench
   * tab bar) instead of the pane's own toolbar row. `null` hides them.
   */
  toolbarHost?: HTMLElement | null
  initialViewState?: PdfViewState | null
  onViewStateChange?(state: PdfViewState): void
  /** Optional scroll sync with the Markdown views (follows and leads by block mapping). */
  scrollSync?: ScrollSyncChannel
  blockMenu?: PdfBlockMenu
}): React.JSX.Element {
  const [blockMenuAt, setBlockMenuAt] = React.useState<{ mappingId: string; x: number; y: number } | null>(null)
  const openBlockMenu = React.useCallback((mappingId: string, x: number, y: number) => setBlockMenuAt({ mappingId, x, y }), [])
  const closeBlockMenu = React.useCallback(() => setBlockMenuAt(null), [])
  const [document, setDocument] = React.useState<PDFDocumentProxy | null>(null)
  const [loadingState, setLoadingState] = React.useState<LoadingState>({ status: 'loading', progress: null })
  const [currentPage, setCurrentPage] = React.useState(1)
  const [zoom, setZoom] = React.useState(() => props.initialViewState?.zoom ?? 1)
  const restoreAnchorRef = React.useRef(props.initialViewState?.anchor ?? null)
  const onViewStateChangeRef = React.useRef(props.onViewStateChange)
  onViewStateChangeRef.current = props.onViewStateChange
  const zoomRef = React.useRef(zoom)
  zoomRef.current = zoom
  const [contentWidth, setContentWidth] = React.useState(0)
  const [pageSizes, setPageSizes] = React.useState<readonly PdfBaseSize[]>([])
  const [reloadKey, setReloadKey] = React.useState(0)
  const [scrollbars, setScrollbars] = React.useState<ScrollbarVisibility>(HIDDEN_SCROLLBARS)
  const scrollerRef = React.useRef<HTMLDivElement>(null)
  const scrollerId = React.useId()
  const [scrollMetrics, setScrollMetrics] = React.useState(EMPTY_SCROLL_METRICS)
  const updateScrollMetrics = React.useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const next: ScrollMetrics = {
      width: scroller.clientWidth, height: scroller.clientHeight,
      contentWidth: scroller.scrollWidth, contentHeight: scroller.scrollHeight,
      left: scroller.scrollLeft, top: scroller.scrollTop
    }
    setScrollMetrics((current) => Object.keys(next).every((key) => current[key as keyof ScrollMetrics] === next[key as keyof ScrollMetrics]) ? current : next)
  }, [])
  const scrollbarHideTimerRef = React.useRef<number | null>(null)
  const scrollbarDraggingRef = React.useRef(false)
  const scrollFrameRef = React.useRef<number | null>(null)
  const mappingsByPage = React.useMemo(() => indexMappingsByPage(props.mappings, document?.numPages ?? 0), [document?.numPages, props.mappings])
  const pageLayout = React.useMemo(() => buildPdfPageLayout(pageSizes, contentWidth, zoom), [contentWidth, pageSizes, zoom])
  const pageLayoutRef = React.useRef(pageLayout)
  const layoutDocumentRef = React.useRef(document)
  const scrollAnchorRef = React.useRef<PdfScrollAnchor | null>(null)
  const renderWindow = pdfRenderWindow(currentPage - 1, pageSizes.length, PAGE_RENDER_RADIUS)
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const scrollIntentRef = React.useRef<ScrollIntent | null>(null)
  const mappingsByPageRef = React.useRef(mappingsByPage)
  mappingsByPageRef.current = mappingsByPage
  const mappingsRef = React.useRef(props.mappings)
  mappingsRef.current = props.mappings

  // Scroll sync: follow other views to a block, and lead with the block on the reading line.
  React.useEffect(() => {
    const viewport = viewportRef.current
    const channel = props.scrollSync
    if (!viewport || !channel) return
    const intent = trackScrollIntent(viewport)
    scrollIntentRef.current = intent
    const unregister = channel.register((position) => {
      const scroller = scrollerRef.current
      const mapping = mappingsRef.current.find((item) => item.id === position.mappingId)
      const box = mapping ? findTargetBox(mapping) : undefined
      if (!scroller || !box || box.pageIndex >= pageLayoutRef.current.pages.length) return
      const [, top, , bottom] = box.bbox
      const anchor: PdfScrollAnchor = {
        pageIndex: box.pageIndex,
        pageFraction: (top + position.fraction * (bottom - top)) / box.pageSize[1],
        viewportFraction: SYNC_READING_LINE
      }
      intent.markProgrammatic()
      scrollAnchorRef.current = anchor
      scroller.scrollTo({ top: pdfScrollTopForAnchor(pageLayoutRef.current, anchor, scroller.clientHeight), behavior: 'instant' })
    })
    return () => {
      unregister()
      intent.dispose()
      scrollIntentRef.current = null
    }
  }, [props.scrollSync])

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
    updateScrollMetrics()
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
  }, [cancelScrollbarHide, hideScrollbars, scheduleScrollbarHide, updateScrollMetrics])

  const startScrollbarDrag = React.useCallback(() => {
    cancelScrollbarHide()
    scrollbarDraggingRef.current = true
  }, [cancelScrollbarHide])

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
        const restorePage = restoreAnchorRef.current?.pageIndex
        setCurrentPage(restorePage !== undefined && restorePage < value.numPages ? restorePage + 1 : 1)
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
      updateScrollMetrics()
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [updateScrollMetrics])

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
        const restore = document ? restoreAnchorRef.current : null
        if (restore && restore.pageIndex < pageLayout.pages.length) {
          // Resume a moved or reopened pane; later page-size updates keep this anchor.
          restoreAnchorRef.current = null
          scroller.scrollTo({ top: pdfScrollTopForAnchor(pageLayout, restore, scroller.clientHeight), left: 0, behavior: 'instant' })
        } else {
          scroller.scrollTo({ top: 0, left: 0, behavior: 'instant' })
        }
      } else if (scrollAnchorRef.current) {
        scroller.scrollTo({
          top: pdfScrollTopForAnchor(pageLayout, scrollAnchorRef.current, scroller.clientHeight),
          behavior: 'instant'
        })
      }
    }
    scrollAnchorRef.current = capturePdfScrollAnchor(pageLayout, scroller.scrollTop, scroller.clientHeight)
  }, [document, pageLayout])

  React.useLayoutEffect(updateScrollMetrics, [pageLayout, currentPage, updateScrollMetrics])

  React.useEffect(() => {
    if (document) onViewStateChangeRef.current?.({ zoom, anchor: scrollAnchorRef.current })
  }, [currentPage, document, zoom])

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
    if (props.scrollSync && scrollIntentRef.current?.isUserScroll()) {
      const position = pdfSyncPosition(pageLayoutRef.current, mappingsByPageRef.current, scroller.scrollTop + scroller.clientHeight * SYNC_READING_LINE)
      if (position) props.scrollSync.report(position)
    }
    // Capture immediately: a queued scroll frame can be overtaken by resizing.
    scrollAnchorRef.current = capturePdfScrollAnchor(pageLayoutRef.current, scroller.scrollTop, scroller.clientHeight)
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null
      updateScrollMetrics()
      const scroller = scrollerRef.current
      if (!scroller || pageLayoutRef.current.pages.length === 0) return
      const pageIndex = pageIndexAtOffset(pageLayoutRef.current, scroller.scrollTop + scroller.clientHeight * PDF_VIEWPORT_FOCUS)
      setCurrentPage((current) => current === pageIndex + 1 ? current : pageIndex + 1)
      onViewStateChangeRef.current?.({ zoom: zoomRef.current, anchor: scrollAnchorRef.current })
    })
  }, [props.scrollSync, updateScrollMetrics])
  const retry = React.useCallback(() => setReloadKey((value) => value + 1), [])
  const onPageError = React.useCallback((message: string) => setLoadingState({ status: 'error', message }), [])
  const onPdfBlock = React.useCallback((mappingId: string, blockPosition: string) => {
    props.onSelect({ mappingId, blockPosition, origin: 'pdf' })
  }, [props.onSelect])

  const embedded = props.toolbarHost !== undefined
  const controls = (
        <Space size="small">
          <Button disabled={!document} type="text" icon={<LeftOutlined />} onClick={() => goToPage(currentPage - 1)} aria-label="上一页" />
          <span>{currentPage} / {document?.numPages ?? '-'}</span>
          <Button disabled={!document} type="text" icon={<RightOutlined />} onClick={() => goToPage(currentPage + 1)} aria-label="下一页" />
          <Button disabled={!document} type="text" icon={<MinusOutlined />} onClick={() => setZoom((value) => Math.max(0.6, value - 0.1))} aria-label="缩小" />
          <span>{Math.round(zoom * 100)}%</span>
          <Button disabled={!document} type="text" icon={<PlusOutlined />} onClick={() => setZoom((value) => Math.min(2, value + 0.1))} aria-label="放大" />
        </Space>
  )

  return (
    <div className={embedded ? 'pdf-pane embedded' : 'pdf-pane'}>
      {embedded
        ? props.toolbarHost ? createPortal(<div className="pdf-toolbar">{controls}</div>, props.toolbarHost) : null
        : <div className="pdf-toolbar"><strong>原文件</strong>{controls}</div>}
      <div className="pdf-viewport" ref={viewportRef} onPointerMove={revealScrollbarsNearEdge} onPointerLeave={scheduleScrollbarHide}>
        <div
          className={`pdf-scroll${scrollbars.vertical ? ' pdf-scrollbar-y-visible' : ''}${scrollbars.horizontal ? ' pdf-scrollbar-x-visible' : ''}`}
          ref={scrollerRef}
          id={scrollerId}
          aria-live="polite"
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
                boxed={props.blockMenu?.boxed}
                deleted={props.blockMenu?.deleted}
                onBlockMenu={props.blockMenu ? openBlockMenu : undefined}
              />
                )
              })}
              {renderWindow.end < pageSizes.length ? <div className="pdf-page-spacer" style={{ height: remainingPdfLayoutHeight(pageLayout, renderWindow.end) }} aria-hidden="true" /> : null}
            </>
            : null}
        </div>
        {blockMenuAt && props.blockMenu ? <BlockContextMenu x={blockMenuAt.x} y={blockMenuAt.y} items={props.blockMenu.items(blockMenuAt.mappingId)}
          onSelect={(key) => props.blockMenu?.onSelect(key, blockMenuAt.mappingId)} onClose={closeBlockMenu} /> : null}
        {(['vertical', 'horizontal'] as const).map((axis) => (
          <PdfScrollbar key={axis} axis={axis} visible={scrollbars[axis]} metrics={scrollMetrics}
            scrollerRef={scrollerRef} scrollerId={scrollerId} onDragStart={startScrollbarDrag} onDragEnd={finishScrollbarDrag} />
        ))}
      </div>
    </div>
  )
}
