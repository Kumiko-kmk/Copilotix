import React from 'react'
import { LeftOutlined, MinusOutlined, PlusOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons'
import { Alert, Button, Progress, Space } from 'antd'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import type { BlockBox, BlockMapping } from '@shared/types'

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString()

type LoadingState =
  | { status: 'loading'; progress: number | null }
  | { status: 'ready' }
  | { status: 'error'; message: string }

const RANGE_CHUNK_SIZE = 256 * 1024
const PAGE_RENDER_RADIUS = 2

export default function PdfPane(props: {
  url: string
  mappings: BlockMapping[]
  activeBlockId: string | null
  onActiveBlock(blockId: string): void
}): React.JSX.Element {
  const [document, setDocument] = React.useState<PDFDocumentProxy | null>(null)
  const [loadingState, setLoadingState] = React.useState<LoadingState>({ status: 'loading', progress: null })
  const [currentPage, setCurrentPage] = React.useState(1)
  const [zoom, setZoom] = React.useState(1)
  const [reloadKey, setReloadKey] = React.useState(0)
  const scrollerRef = React.useRef<HTMLDivElement>(null)
  const suppressNavigationRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    let loadingTask: PDFDocumentLoadingTask | null = pdfjs.getDocument({
      url: props.url,
      rangeChunkSize: RANGE_CHUNK_SIZE
    })
    setDocument(null)
    setLoadingState({ status: 'loading', progress: null })
    loadingTask.onProgress = ({ loaded, total }) => {
      if (!cancelled) setLoadingState({ status: 'loading', progress: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null })
    }
    loadingTask.onPassword = () => {
      if (!cancelled) setLoadingState({ status: 'error', message: '该 PDF 受密码保护，当前阅读器无法打开。' })
      void loadingTask?.destroy()
    }
    void loadingTask.promise
      .then((value) => {
        if (cancelled) {
          void value.destroy()
          return
        }
        setDocument(value)
        setCurrentPage(1)
        setLoadingState({ status: 'ready' })
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadingState({ status: 'error', message: pdfErrorMessage(error) })
      })
    return () => {
      cancelled = true
      void loadingTask?.destroy()
      loadingTask = null
    }
  }, [props.url, reloadKey])

  React.useEffect(() => {
    if (!props.activeBlockId) return
    if (suppressNavigationRef.current === props.activeBlockId) {
      suppressNavigationRef.current = null
      return
    }
    const mapping = props.mappings.find((item) => item.id === props.activeBlockId)
    const pageIndex = mapping?.boxes[0]?.pageIndex
    if (pageIndex === undefined) return
    setCurrentPage(pageIndex + 1)
    requestAnimationFrame(() => {
      scrollerRef.current?.querySelector<HTMLElement>(`[data-pdf-page="${pageIndex}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [props.activeBlockId, props.mappings])

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
  const onPdfBlock = React.useCallback((blockId: string) => {
    suppressNavigationRef.current = blockId
    props.onActiveBlock(blockId)
  }, [props.onActiveBlock])

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
      <div className="pdf-scroll" ref={scrollerRef} aria-live="polite">
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
                activeBlockId={props.activeBlockId}
                onActiveBlock={onPdfBlock}
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
  activeBlockId: string | null
  onActiveBlock(blockId: string): void
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
                props.activeBlockId === mapping.id ? 'active' : '',
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
              onClick={() => props.onActiveBlock(mapping.id)}
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
