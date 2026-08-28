import React from 'react'
import { LeftOutlined, MinusOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons'
import { Button, Space } from 'antd'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { BlockMapping } from '@shared/types'

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

export default function PdfPane(props: {
  url: string
  mappings: BlockMapping[]
  activeBlockId: string | null
  onActiveBlock(blockId: string): void
}): React.JSX.Element {
  const [document, setDocument] = React.useState<PDFDocumentProxy | null>(null)
  const [currentPage, setCurrentPage] = React.useState(1)
  const [zoom, setZoom] = React.useState(1)
  const scrollerRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    let cancelled = false
    const loading = pdfjs.getDocument(props.url)
    void loading.promise.then((value) => { if (!cancelled) setDocument(value) })
    return () => { cancelled = true; void loading.destroy() }
  }, [props.url])

  React.useEffect(() => {
    if (!props.activeBlockId) return
    const mapping = props.mappings.find((item) => item.id === props.activeBlockId)
    const pageIndex = mapping?.boxes[0]?.pageIndex
    if (pageIndex === undefined) return
    setCurrentPage(pageIndex + 1)
    scrollerRef.current?.querySelector<HTMLElement>(`[data-pdf-page="${pageIndex}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [props.activeBlockId, props.mappings])

  const goToPage = React.useCallback((page: number) => {
    if (!document) return
    const next = Math.max(1, Math.min(document.numPages, page))
    setCurrentPage(next)
    scrollerRef.current?.querySelector<HTMLElement>(`[data-pdf-page="${next - 1}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [document])

  return (
    <div className="pdf-pane">
      <div className="pdf-toolbar">
        <strong>原文件</strong>
        <Space size="small">
          <Button type="text" icon={<LeftOutlined />} onClick={() => goToPage(currentPage - 1)} aria-label="上一页" />
          <span>{currentPage} / {document?.numPages ?? '-'}</span>
          <Button type="text" icon={<RightOutlined />} onClick={() => goToPage(currentPage + 1)} aria-label="下一页" />
          <Button type="text" icon={<MinusOutlined />} onClick={() => setZoom((value) => Math.max(0.6, value - 0.1))} aria-label="缩小" />
          <span>{Math.round(zoom * 100)}%</span>
          <Button type="text" icon={<PlusOutlined />} onClick={() => setZoom((value) => Math.min(2, value + 0.1))} aria-label="放大" />
        </Space>
      </div>
      <div className="pdf-scroll" ref={scrollerRef}>
        {document
          ? Array.from({ length: document.numPages }, (_, pageIndex) => (
              <PdfPage
                key={pageIndex}
                document={document}
                pageIndex={pageIndex}
                zoom={zoom}
                mappings={props.mappings}
                activeBlockId={props.activeBlockId}
                onActiveBlock={props.onActiveBlock}
                onVisible={() => setCurrentPage(pageIndex + 1)}
              />
            ))
          : <div className="pdf-loading">正在加载 PDF…</div>}
      </div>
    </div>
  )
}

function PdfPage(props: {
  document: PDFDocumentProxy
  pageIndex: number
  zoom: number
  mappings: BlockMapping[]
  activeBlockId: string | null
  onActiveBlock(blockId: string): void
  onVisible(): void
}): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const pageRef = React.useRef<HTMLDivElement>(null)
  const [page, setPage] = React.useState<PDFPageProxy | null>(null)
  const [size, setSize] = React.useState({ width: 612, height: 792 })

  React.useEffect(() => {
    let cancelled = false
    void props.document.getPage(props.pageIndex + 1).then((value) => { if (!cancelled) setPage(value) })
    return () => { cancelled = true }
  }, [props.document, props.pageIndex])

  React.useEffect(() => {
    if (!page || !canvasRef.current) return
    const viewport = page.getViewport({ scale: props.zoom * 1.25 })
    const canvas = canvasRef.current
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.floor(viewport.width * ratio)
    canvas.height = Math.floor(viewport.height * ratio)
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`
    setSize({ width: viewport.width, height: viewport.height })
    const context = canvas.getContext('2d')
    if (!context) return
    const renderTask = page.render({ canvas, canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
    return () => renderTask.cancel()
  }, [page, props.zoom])

  React.useEffect(() => {
    const element = pageRef.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => { if (entry?.intersectionRatio && entry.intersectionRatio > 0.55) props.onVisible() }, { threshold: [0.55] })
    observer.observe(element)
    return () => observer.disconnect()
  }, [props])

  const overlays = props.mappings.flatMap((mapping) => mapping.boxes.filter((box) => box.pageIndex === props.pageIndex).map((box) => ({ mapping, box })))

  return (
    <div className="pdf-page" data-pdf-page={props.pageIndex} ref={pageRef} style={size}>
      <canvas ref={canvasRef} />
      <div className="pdf-overlay-layer">
        {overlays.map(({ mapping, box }) => {
          const [pageWidth, pageHeight] = box.pageSize
          const [x0, y0, x1, y1] = box.bbox
          return <button key={`${mapping.id}-${box.blockPosition}`} className={props.activeBlockId === mapping.id ? 'pdf-block active' : 'pdf-block'} style={{ left: `${(x0 / pageWidth) * 100}%`, top: `${(y0 / pageHeight) * 100}%`, width: `${((x1 - x0) / pageWidth) * 100}%`, height: `${((y1 - y0) / pageHeight) * 100}%` }} onClick={() => props.onActiveBlock(mapping.id)} aria-label={`定位区块 ${mapping.order + 1}`} />
        })}
      </div>
    </div>
  )
}
