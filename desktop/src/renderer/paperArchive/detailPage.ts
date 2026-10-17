import { acquirePdfDocument } from '../pdfDocumentCache'

/** The first page as shown behind the frosted cover, plus the page count when it is a PDF. */
export interface DetailPage {
  canvas: HTMLCanvasElement
  pages: number | null
  /** The key-figure sheet beside the first page (figureSpread.ts); the spread is composed when shown. */
  figures?: { sheet: HTMLCanvasElement }
}

const PAGE_PIXEL_HEIGHT = 1600
const CACHE_LIMIT = 6
const cache = new Map<string, Promise<DetailPage>>()

/** Render (or reuse) page 1 of a paper. Failed renders are not cached so a retry can succeed. */
export function loadDetailPage(key: string, create: () => Promise<DetailPage>, signal?: AbortSignal): Promise<DetailPage> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  const cached = cache.get(key)
  if (cached) {
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }
  const promise = create()
  cache.set(key, promise)
  const evict = (): void => { if (cache.get(key) === promise) cache.delete(key) }
  signal?.addEventListener('abort', evict, { once: true })
  const cleanup = (): void => signal?.removeEventListener('abort', evict)
  void promise.then(cleanup, () => { evict(); cleanup() })
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return promise
}

export async function renderPdfFirstPage(url: string): Promise<DetailPage> {
  const handle = acquirePdfDocument(url)
  try {
    const document = await handle.promise
    const page = await document.getPage(1)
    try {
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: PAGE_PIXEL_HEIGHT / base.height })
      const canvas = window.document.createElement('canvas')
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('无法创建论文首页画布')
      await page.render({ canvas, canvasContext: context, viewport, background: 'rgb(255,255,255)' }).promise
      return { canvas, pages: document.numPages }
    } finally {
      page.cleanup()
    }
  } finally {
    handle.release()
  }
}

/** Markdown sources have no page image: typeset the title and abstract onto a paper-sized sheet. */
export function drawTextPage(title: string, abstract: string | null): DetailPage {
  const width = Math.round(PAGE_PIXEL_HEIGHT / Math.SQRT2)
  const canvas = window.document.createElement('canvas')
  canvas.width = width
  canvas.height = PAGE_PIXEL_HEIGHT
  const context = canvas.getContext('2d', { alpha: false })!
  context.fillStyle = '#fffdf8'
  context.fillRect(0, 0, width, PAGE_PIXEL_HEIGHT)
  const margin = 110
  let y = 230
  const font = '"Microsoft YaHei UI", "PingFang SC", Georgia, serif'
  context.fillStyle = '#1f1b16'
  context.font = `700 52px ${font}`
  y = wrapText(context, title, margin, y, width - margin * 2, 70, 4)
  context.fillStyle = '#8a8174'
  context.fillRect(margin, y + 20, width - margin * 2, 3)
  if (abstract) {
    context.fillStyle = '#3b352d'
    context.font = `400 30px ${font}`
    wrapText(context, abstract, margin, y + 100, width - margin * 2, 48, 18)
  }
  return { canvas, pages: null }
}

function wrapText(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number): number {
  // Break per character so CJK and Latin text both wrap without a segmenter.
  let line = ''
  let lines = 0
  for (const character of text) {
    if (context.measureText(line + character).width > maxWidth && line) {
      if (++lines >= maxLines) {
        context.fillText(`${line.slice(0, -1)}…`, x, y)
        return y + lineHeight
      }
      context.fillText(line, x, y)
      y += lineHeight
      line = character.trimStart()
    } else line += character
  }
  if (line) context.fillText(line, x, y)
  return y + lineHeight
}
