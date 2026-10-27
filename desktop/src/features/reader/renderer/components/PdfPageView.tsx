import React from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { BlockMapping } from '@features/parsing/contract/blocks'
import type { BlockSelection } from '../../contract/readerTypes'
import { pdfPageRenderScheduler, type ScheduledPdfRender } from '../pdfRenderScheduler'
import { recordReaderDuration } from '../readerPerformance'
import { pdfPageMetrics, pdfCanvasOutput, buildMergeConnectors, blockTypeLabel, pdfErrorMessage, isRenderingCancelled, type PdfBaseSize, type ScrollMetrics } from './pdfLayout'

/** One rendered PDF page with its block overlays, and the floating scrollbar of the PDF view. */

export function PdfScrollbar(props: {
  axis: 'vertical' | 'horizontal'
  visible: boolean
  metrics: ScrollMetrics
  scrollerRef: React.RefObject<HTMLDivElement | null>
  scrollerId: string
  onDragStart(): void
  onDragEnd(): void
}): React.JSX.Element | null {
  const vertical = props.axis === 'vertical'
  const viewport = vertical ? props.metrics.height : props.metrics.width
  const content = vertical ? props.metrics.contentHeight : props.metrics.contentWidth
  const offset = vertical ? props.metrics.top : props.metrics.left
  const maximum = Math.max(0, content - viewport)
  const thumbLength = Math.min(viewport, Math.max(32, viewport * viewport / content))
  const travel = viewport - thumbLength
  const drag = React.useRef<{ pointerId: number; coordinate: number; offset: number } | null>(null)
  if (maximum <= 0 || travel <= 0) return null
  const move = (position: number): void => {
    props.scrollerRef.current?.scrollTo({ [vertical ? 'top' : 'left']: Math.max(0, Math.min(maximum, position)), behavior: 'instant' })
  }
  const finish = (): void => {
    drag.current = null
    props.onDragEnd()
  }
  return <div className={`pdf-scrollbar pdf-scrollbar-${props.axis}${props.visible ? ' visible' : ''}`}
    role="scrollbar" tabIndex={0} aria-label={vertical ? 'PDF 垂直滚动' : 'PDF 水平滚动'}
    aria-controls={props.scrollerId} aria-orientation={props.axis} aria-valuemin={0} aria-valuemax={maximum} aria-valuenow={offset}
    onPointerDown={(event) => {
      if (event.button !== 0) return
      event.preventDefault()
      const coordinate = vertical ? event.clientY : event.clientX
      if (event.target === event.currentTarget) {
        const bounds = event.currentTarget.getBoundingClientRect()
        move((coordinate - (vertical ? bounds.top : bounds.left) - thumbLength / 2) * maximum / travel)
      }
      drag.current = { pointerId: event.pointerId, coordinate, offset: vertical ? props.scrollerRef.current?.scrollTop ?? 0 : props.scrollerRef.current?.scrollLeft ?? 0 }
      event.currentTarget.setPointerCapture(event.pointerId)
      props.onDragStart()
    }}
    onPointerMove={(event) => {
      const origin = drag.current
      if (!origin || origin.pointerId !== event.pointerId) return
      move(origin.offset + ((vertical ? event.clientY : event.clientX) - origin.coordinate) * maximum / travel)
    }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onKeyDown={(event) => {
      const change = ({ ArrowUp: -40, ArrowDown: 40, ArrowLeft: -40, ArrowRight: 40, PageUp: -viewport * 0.9, PageDown: viewport * 0.9 } as Record<string, number>)[event.key]
      if (change === undefined && event.key !== 'Home' && event.key !== 'End') return
      event.preventDefault()
      move(event.key === 'Home' ? 0 : event.key === 'End' ? maximum : offset + (change ?? 0))
    }}>
    <div className="pdf-scrollbar-thumb" style={vertical
      ? { height: thumbLength, top: offset / maximum * travel }
      : { width: thumbLength, left: offset / maximum * travel }} />
  </div>
}

export const PdfPage = React.memo(function PdfPage(props: {
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
  boxed?: ReadonlySet<string>
  deleted?: ReadonlySet<string>
  onBlockMenu?(mappingId: string, x: number, y: number): void
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
      // A detached page no longer needs its backing pixels. Wait for cancellation,
      // so a queued renderer never writes into a canvas while it is being released.
      void renderTask.promise.catch(() => undefined).finally(() => {
        if (!canvas.isConnected) { canvas.width = 0; canvas.height = 0 }
      })
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
                box.mergeRole ? 'merged' : '',
                props.boxed?.has(mapping.id) ? 'boxed' : '',
                props.deleted?.has(mapping.id) ? 'deleted' : ''
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
              onContextMenu={props.onBlockMenu ? (event) => {
                event.preventDefault()
                props.onSelect(mapping.id, box.blockPosition)
                props.onBlockMenu!(mapping.id, event.clientX, event.clientY)
              } : undefined}
              aria-label={`${blockTypeLabel(mapping.type)}区块 ${mapping.order + 1}${box.mergeRole === 'continuation' ? '（合并续块）' : ''}`}
            >
              {box.mergeRole === 'continuation' ? <span className="pdf-merge-badge">合并</span> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
})
