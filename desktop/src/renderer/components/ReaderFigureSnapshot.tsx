import React from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { acquirePdfDocument } from '../pdfDocumentCache'
import type { ReaderFigureGroup } from '../readerFigureGroups'

const REGION_PIXEL_WIDTH = 1_200
const regionCache = new Map<string, Promise<HTMLCanvasElement>>()

export default function ReaderFigureSnapshot(props: {
  pdfUrl: string
  group: ReaderFigureGroup
  fallback: React.ReactNode
  onRendered(): void
}): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = React.useState(false)
  const [ready, setReady] = React.useState(false)
  React.useEffect(() => {
    let cancelled = false
    void renderCachedRegion(props.pdfUrl, props.group)
      .then((source) => {
        if (cancelled || !canvasRef.current) return
        const canvas = canvasRef.current
        canvas.width = source.width
        canvas.height = source.height
        const context = canvas.getContext('2d')
        if (!context) throw new Error('无法创建复合图画布')
        context.drawImage(source, 0, 0)
        setReady(true)
        props.onRendered()
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true)
          props.onRendered()
        }
      })
    return () => { cancelled = true }
  }, [props.group, props.onRendered, props.pdfUrl])

  return (
    <div
      ref={hostRef}
      className="reader-figure-snapshot"
      style={{ aspectRatio: `${boxWidth(props.group.cropBox)} / ${boxHeight(props.group.cropBox)}` }}
      data-rendered={ready}
      data-failed={failed}
      data-reader-annotation-ignore="true"
    >
      {failed ? props.fallback : null}
      <canvas
        ref={canvasRef}
        className="reader-figure-snapshot-canvas"
        aria-label="PDF 复合图"
      />
    </div>
  )
}

function renderCachedRegion(pdfUrl: string, group: ReaderFigureGroup): Promise<HTMLCanvasElement> {
  const key = `${pdfUrl}|${group.pageIndex}|${group.cropBox.join(',')}`
  const existing = regionCache.get(key)
  if (existing) return existing
  const rendering = renderRegion(pdfUrl, group).catch((error) => {
    regionCache.delete(key)
    throw error
  })
  regionCache.set(key, rendering)
  if (regionCache.size > 24) regionCache.delete(regionCache.keys().next().value!)
  return rendering
}

async function renderRegion(pdfUrl: string, group: ReaderFigureGroup): Promise<HTMLCanvasElement> {
  const handle = acquirePdfDocument(pdfUrl)
  try {
    const document = await handle.promise
    return await renderDocumentRegion(document, group)
  } finally {
    handle.release()
  }
}

export async function renderDocumentRegion(
  document: PDFDocumentProxy,
  group: Pick<ReaderFigureGroup, 'pageIndex' | 'cropBox'>
): Promise<HTMLCanvasElement> {
  const page = await document.getPage(group.pageIndex + 1)
  const cropWidth = boxWidth(group.cropBox)
  const cropHeight = boxHeight(group.cropBox)
  const scale = REGION_PIXEL_WIDTH / Math.max(1, cropWidth)
  const viewport = page.getViewport({ scale })
  const canvas = window.document.createElement('canvas')
  canvas.width = REGION_PIXEL_WIDTH
  canvas.height = Math.max(1, Math.round(cropHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建复合图画布')
  const task = page.render({
    canvas,
    canvasContext: context,
    viewport,
    transform: [1, 0, 0, 1, -group.cropBox[0] * scale, -group.cropBox[1] * scale]
  })
  await task.promise
  return canvas
}

function boxWidth(box: readonly [number, number, number, number]): number {
  return Math.max(1, box[2] - box[0])
}

function boxHeight(box: readonly [number, number, number, number]): number {
  return Math.max(1, box[3] - box[1])
}
