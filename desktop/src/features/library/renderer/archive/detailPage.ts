import { acquirePdfDocument } from '@platform/pdf/renderer/pdfDocumentCache'

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

/**
 * Rendered first pages persist across sessions in renderer storage, keyed by the PDF's content hash,
 * so browsing back to a paper does not re-parse and re-rasterise its PDF (the largest remaining
 * archive cost after the in-memory cache misses). Any storage failure falls back to rendering.
 */
const PAGE_STORE = 'copilotix-archive-pages'
const PAGE_STORE_VERSION = 1
const PAGE_STORE_LIMIT = 160
let pageStore: Promise<IDBDatabase | null> | null = null

function openPageStore(): Promise<IDBDatabase | null> {
  pageStore ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    const request = indexedDB.open(PAGE_STORE, PAGE_STORE_VERSION)
    request.onupgradeneeded = () => request.result.createObjectStore('pages', { keyPath: 'key' }).createIndex('at', 'at')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
  return pageStore
}

interface StoredPage { key: string; blob: Blob; pages: number; at: number }

async function readStoredPage(key: string): Promise<DetailPage | null> {
  try {
    const db = await openPageStore()
    if (!db) return null
    const stored = await new Promise<StoredPage | undefined>((resolve, reject) => {
      const request = db.transaction('pages').objectStore('pages').get(key)
      request.onsuccess = () => resolve(request.result as StoredPage | undefined)
      request.onerror = () => reject(request.error)
    })
    if (!stored) return null
    const bitmap = await createImageBitmap(stored.blob)
    try {
      const canvas = window.document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) return null
      context.drawImage(bitmap, 0, 0)
      return { canvas, pages: stored.pages }
    } finally { bitmap.close() }
  } catch { return null }
}

function storePage(key: string, page: DetailPage): void {
  const pages = page.pages
  if (pages === null) return
  page.canvas.toBlob((blob) => {
    if (!blob) return
    void openPageStore().then((db) => {
      if (!db) return
      const store = db.transaction('pages', 'readwrite').objectStore('pages')
      store.put({ key, blob, pages, at: Date.now() } satisfies StoredPage)
      const count = store.count()
      count.onsuccess = () => {
        let excess = count.result - PAGE_STORE_LIMIT
        if (excess <= 0) return
        store.index('at').openCursor().onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result
          if (!cursor || excess-- <= 0) return
          cursor.delete()
          cursor.continue()
        }
      }
    }).catch(() => undefined)
  }, 'image/webp', 0.92)
}

/** First-page renderer for one PDF content hash: reads the stored page, else renders and stores it. */
/** `onRender` runs only when the stored page is missing and the PDF has to be rendered. */
export function firstPageRenderer(sourceHash: string, onRender?: () => void): (url: string) => Promise<DetailPage> {
  const key = `${sourceHash}:${PAGE_PIXEL_HEIGHT}`
  return async (url) => {
    const stored = await readStoredPage(key)
    if (stored) return stored
    onRender?.()
    const page = await renderPdfFirstPage(url)
    storePage(key, page)
    return page
  }
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
