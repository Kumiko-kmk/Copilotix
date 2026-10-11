import React from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { acquirePdfDocument } from '../pdfDocumentCache'
import type { ReaderFigureGroup } from '../readerFigureGroups'

export type FigureRenderState = 'pending' | 'ready' | 'failed'
export const FIGURE_MAX_PIXELS = 8_000_000
export const FIGURE_MAX_EDGE = 8192
export const FIGURE_CACHE_BYTES = 64 * 1024 * 1024
interface RegionEntry {
  promise: Promise<HTMLCanvasElement>
  controller: AbortController
  references: number
  bytes: number
}
const regionCache = new Map<string, RegionEntry>()
let cachedBytes = 0
export function figureRegionCacheStats(): { bytes: number; entries: number } {
  return { bytes: cachedBytes, entries: regionCache.size }
}

export default function ReaderFigureSnapshot(props: {
  pdfUrl: string
  group: ReaderFigureGroup
  onRendered(): void
  onStateChange(state: FigureRenderState): void
}): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const callbacks = React.useRef(props)
  callbacks.current = props
  const key = props.pdfUrl + '|' + props.group.pageIndex + '|' + props.group.cropBox.join(',') + '|' + props.group.pageSize.join(',')
  const [state, setState] = React.useState<{ key: string; status: FigureRenderState }>({ key, status: 'pending' })
  const [attempt, setAttempt] = React.useState(0)
  const status = state.key === key ? state.status : 'pending'

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let started = false
    let release: (() => void) | undefined
    const input = callbacks.current
    setState({ key, status: 'pending' })
    callbacks.current.onStateChange('pending')
    // Detached/offscreen sources stay visible; the article need not wait for
    // all of a long paper's PDF crops before becoming readable.
    const start = (): void => {
      if (started || cancelled) return
      started = true
      const width = Math.max(1, host.parentElement?.clientWidth ?? 600)
      const request = acquireRegion(input.pdfUrl, input.group, width * Math.max(1, window.devicePixelRatio))
      release = request.release
      void request.promise.then(source => {
        if (cancelled || !canvasRef.current) return
        const canvas = canvasRef.current
        canvas.width = source.width
        canvas.height = source.height
        const context = canvas.getContext('2d')
        if (!context) throw new Error('无法创建复合图画布')
        context.drawImage(source, 0, 0)
        setState({ key, status: 'ready' })
        callbacks.current.onStateChange('ready')
        callbacks.current.onRendered()
      }).catch(() => {
        if (cancelled) return
        setState({ key, status: 'failed' })
        callbacks.current.onStateChange('failed')
        callbacks.current.onRendered()
      }).finally(() => { release?.(); release = undefined })
    }
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); start() }
    }, { root: host.closest('.markdown-scroll'), rootMargin: '320px' })
    if (observer) observer.observe(host)
    else start()
    return () => { cancelled = true; observer?.disconnect(); release?.() }
  }, [key, attempt])

  return (
    <div ref={hostRef} className="reader-figure-snapshot" data-rendered={status === 'ready'}
      data-failed={status === 'failed'} data-reader-annotation-ignore="true"
      style={status === 'ready' ? { aspectRatio: (props.group.cropBox[2] - props.group.cropBox[0]) + ' / ' + (props.group.cropBox[3] - props.group.cropBox[1]) } : undefined}>
      <canvas ref={canvasRef} className="reader-figure-snapshot-canvas" aria-label="PDF 复合图" />
      {status === 'failed' ? <button type="button" className="reader-figure-action" onClick={() => setAttempt(value => value + 1)}>重试整图</button> : null}
    </div>
  )
}

function removeEntry(key: string, entry: RegionEntry): void {
  if (regionCache.get(key) !== entry) return
  regionCache.delete(key)
  cachedBytes -= entry.bytes
}
function acquireRegion(pdfUrl: string, group: ReaderFigureGroup, pixelWidth: number): { promise: Promise<HTMLCanvasElement>; release(): void } {
  // Quantization permits the two language panes to share a crop at similar widths.
  const target = Math.min(2400, Math.max(600, Math.ceil(pixelWidth / 200) * 200))
  const key = pdfUrl + '|' + group.pageIndex + '|' + group.cropBox.join(',') + '|' + group.pageSize.join(',') + '|' + target
  let entry = regionCache.get(key)
  if (entry) {
    regionCache.delete(key)
    regionCache.set(key, entry)
  } else {
    const controller = new AbortController()
    const created: RegionEntry = { controller, references: 0, bytes: 0, promise: Promise.resolve(null as unknown as HTMLCanvasElement) }
    created.promise = renderRegion(pdfUrl, group, target, controller.signal).then(canvas => {
      if (regionCache.get(key) === created) {
        created.bytes = canvas.width * canvas.height * 4
        cachedBytes += created.bytes
        for (const [oldKey, oldEntry] of regionCache) {
          if (cachedBytes <= FIGURE_CACHE_BYTES) break
          if (oldEntry.bytes) removeEntry(oldKey, oldEntry)
        }
      }
      return canvas
    }).catch(error => { removeEntry(key, created); throw error })
    entry = created
    regionCache.set(key, entry)
  }
  entry.references++
  let released = false
  return {
    promise: entry.promise,
    release: () => {
      if (released) return
      released = true
      entry.references--
      if (entry.references === 0 && entry.bytes === 0) {
        removeEntry(key, entry)
        entry.controller.abort()
      }
    }
  }
}

async function renderRegion(pdfUrl: string, group: ReaderFigureGroup, pixelWidth: number, signal: AbortSignal): Promise<HTMLCanvasElement> {
  const handle = acquirePdfDocument(pdfUrl)
  const release = (): void => handle.release()
  signal.addEventListener('abort', release, { once: true })
  try {
    const document = await handle.promise
    signal.throwIfAborted()
    return await renderDocumentRegion(document, group, pixelWidth, signal)
  } finally { signal.removeEventListener('abort', release); handle.release() }
}

export function figurePixelSize(width: number, height: number, desiredWidth = 1200): [number, number] {
  const scale = Math.min(desiredWidth / width, FIGURE_MAX_EDGE / width, FIGURE_MAX_EDGE / height,
    Math.sqrt(FIGURE_MAX_PIXELS / (width * height)))
  return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))]
}

/** Layout boxes use top-left coordinates on the rotated, displayed PDF page. */
export async function renderDocumentRegion(
  document: PDFDocumentProxy,
  group: Pick<ReaderFigureGroup, 'pageIndex' | 'cropBox'> & Partial<Pick<ReaderFigureGroup, 'pageSize'>>,
  pixelWidth = 1200,
  signal?: AbortSignal
): Promise<HTMLCanvasElement> {
  const page = await document.getPage(group.pageIndex + 1)
  signal?.throwIfAborted()
  const base = page.getViewport({ scale: 1 })
  const size = group.pageSize ?? [base.width, base.height]
  const left = group.cropBox[0] / size[0] * base.width
  const top = group.cropBox[1] / size[1] * base.height
  const cropWidth = (group.cropBox[2] - group.cropBox[0]) / size[0] * base.width
  const cropHeight = (group.cropBox[3] - group.cropBox[1]) / size[1] * base.height
  if (![left, top, cropWidth, cropHeight].every(Number.isFinite) || cropWidth <= 0 || cropHeight <= 0) throw new Error('无效图区')
  const [width, height] = figurePixelSize(cropWidth, cropHeight, pixelWidth)
  const scale = width / cropWidth
  const viewport = page.getViewport({ scale })
  const canvas = window.document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建复合图画布')
  const task = page.render({ canvas, canvasContext: context, viewport,
    transform: [1, 0, 0, 1, -left * scale, -top * scale] })
  const cancel = (): void => task.cancel()
  signal?.addEventListener('abort', cancel, { once: true })
  try { await task.promise; signal?.throwIfAborted(); return canvas }
  finally { signal?.removeEventListener('abort', cancel) }
}
