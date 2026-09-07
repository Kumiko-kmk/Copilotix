import React from 'react'
import { LeftOutlined, MinusOutlined, PlusOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons'
import { Alert, Button, Progress, Space } from 'antd'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import type { BlockBox, BlockMapping, BlockSelection } from '@shared/types'
import { acquirePdfDocument } from '../pdfDocumentCache'

type LoadingState =
  | { status: 'loading'; progress: number | null }
  | { status: 'ready' }
  | { status: 'error'; message: string }

const PAGE_RENDER_RADIUS = 2
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
  const [reloadKey, setReloadKey] = React.useState(0)
  const [scrollbars, setScrollbars] = React.useState<ScrollbarVisibility>(HIDDEN_SCROLLBARS)
  const scrollerRef = React.useRef<HTMLDivElement>(null)
  const scrollbarHideTimerRef = React.useRef<number | null>(null)
  const scrollbarDraggingRef = React.useRef(false)

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

  React.useEffect(() => {
    const selection = props.selection
    if (!selection || selection.origin !== 'markdown') return
    const mapping = props.mappings.find((item) => item.id === selection.mappingId)
    const targetBox = mapping ? findTargetBox(mapping, selection.blockPosition) : undefined
    const pageIndex = targetBox?.pageIndex
    if (!mapping || !targetBox || pageIndex === undefined) return
    setCurrentPage(pageIndex + 1)
    requestAnimationFrame(() => {
      const page = scrollerRef.current?.querySelector<HTMLElement>(`[data-pdf-page="${pageIndex}"]`)
      if (!page) return
      const target = Array.from(page.querySelectorAll<HTMLElement>('[data-block-id]')).find(
        (element) => element.dataset.blockId === mapping.id && element.dataset.blockPosition === targetBox.blockPosition
      )
      const destination = target ?? page
      destination.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
    })
  }, [props.mappings, props.selection])

  const goToPage = React.useCallback((page: number) => {
    if (!document) return
    const next = Math.max(1, Math.min(document.numPages, page))
    setCurrentPage(next)
    requestAnimationFrame(() => {
      scrollerRef.current?.querySelector<HTMLElement>(`[data-pdf-page="${next - 1}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [document])

  const onVisiblePage = React.useCallback((pageIndex: number) => setCurrentPage(pageIndex + 1), [])
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
          ? Array.from({ length: document.numPages }, (_, pageIndex) => (
              <PdfPage
                key={pageIndex}
                document={document}
                pageIndex={pageIndex}
                zoom={zoom}
                shouldRender={Math.abs(pageIndex - (currentPage - 1)) <= PAGE_RENDER_RADIUS}
                mappings={props.mappings}
                selection={props.selection}
                onSelect={onPdfBlock}
                onVisible={onVisiblePage}
                onError={onPageError}
              />
            ))
          : null}
      </div>
    </div>
  )
}

const PdfPage = React.memo(function PdfPage(props: {
  document: PDFDocumentProxy
  pageIndex: number
  zoom: number
  shouldRender: boolean
  mappings: BlockMapping[]
  selection: BlockSelection | null
  onSelect(mappingId: string, blockPosition: string): void
  onVisible(pageIndex: number): void
  onError(message: string): void
}): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const pageRef = React.useRef<HTMLDivElement>(null)
  const renderTaskRef = React.useRef<RenderTask | null>(null)
  const [page, setPage] = React.useState<PDFPageProxy | null>(null)
  const [baseSize, setBaseSize] = React.useState({ width: 612, height: 792 })
  const scale = props.zoom * 1.25
  const size = { width: baseSize.width * scale, height: baseSize.height * scale }

  React.useEffect(() => {
    if (!props.shouldRender) {
      renderTaskRef.current?.cancel()
      setPage((current) => {
        current?.cleanup()
        return null
      })
      const canvas = canvasRef.current
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
      return
    }
    let cancelled = false
    void props.document.getPage(props.pageIndex + 1)
      .then((value) => {
        if (cancelled) {
          value.cleanup()
          return
        }
        const viewport = value.getViewport({ scale: 1 })
        setBaseSize({ width: viewport.width, height: viewport.height })
        setPage(value)
      })
      .catch((error: unknown) => { if (!cancelled) props.onError(pdfErrorMessage(error)) })
    return () => { cancelled = true }
  }, [props.document, props.onError, props.pageIndex, props.shouldRender])

  React.useEffect(() => {
    if (!page || !canvasRef.current || !props.shouldRender) return
    const viewport = page.getViewport({ scale })
    const canvas = canvasRef.current
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.floor(viewport.width * ratio)
    canvas.height = Math.floor(viewport.height * ratio)
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`
    const context = canvas.getContext('2d')
    if (!context) return
    const renderTask = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0]
    })
    renderTaskRef.current = renderTask
    void renderTask.promise.catch((error: unknown) => {
      if (!isRenderingCancelled(error)) props.onError(pdfErrorMessage(error))
    })
    return () => {
      renderTask.cancel()
      renderTaskRef.current = null
    }
  }, [page, props.onError, props.shouldRender, scale])

  React.useEffect(() => {
    const element = pageRef.current
    if (!element) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry && entry.intersectionRatio > 0.55) props.onVisible(props.pageIndex) },
      { threshold: [0.55] }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [props.onVisible, props.pageIndex])

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

function findTargetBox(mapping: BlockMapping, blockPosition?: string): BlockBox | undefined {
  return (
    (blockPosition ? mapping.boxes.find((box) => box.blockPosition === blockPosition) : undefined) ??
    mapping.boxes.find((box) => box.mergeRole === 'source') ??
    mapping.boxes[0]
  )
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
