import { readFile } from 'node:fs/promises'
import type { TextLayerItem, TextLayerPage } from '../core/textLayerRepair'

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

let pdfjs: Promise<PdfJs> | undefined

/**
 * pdf.js runs in this process through its fake worker; it is loaded only when
 * a parse result has fragmented spans, so ordinary papers never pay for it.
 */
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= (async () => {
    // Electron's utility process is neither Node nor a browser to pdf.js, which
    // builds a DOMMatrix at module load. Text extraction never renders, so an
    // identity stub is enough when the global is missing.
    const scope = globalThis as { DOMMatrix?: unknown }
    scope.DOMMatrix ??= class { a = 1; b = 0; c = 0; d = 1; e = 0; f = 0 }
    const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
    ;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker
    return import('pdfjs-dist/legacy/build/pdf.mjs')
  })().catch((error: unknown) => {
    pdfjs = undefined
    throw error
  })
  return pdfjs
}

/**
 * Read text items for the requested pages in layout coordinates. Rotated pages,
 * rotated or skewed runs and pages that fail to load are left out, which keeps
 * their candidates on the parser text.
 */
export async function readPdfTextLayer(
  pdfPath: string,
  pages: ReadonlyArray<{ pageIndex: number; pageSize: [number, number] }>,
  signal?: AbortSignal
): Promise<TextLayerPage[]> {
  if (pages.length === 0) return []
  const { getDocument, Util } = await loadPdfJs()
  signal?.throwIfAborted()
  const data = new Uint8Array(await readFile(pdfPath, { signal }))
  const task = getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    stopAtErrors: false,
    verbosity: 0
  })
  try {
    const document = await task.promise
    const result: TextLayerPage[] = []
    for (const { pageIndex, pageSize } of pages) {
      signal?.throwIfAborted()
      if (pageIndex < 0 || pageIndex >= document.numPages) continue
      try {
        const page = await document.getPage(pageIndex + 1)
        const viewport = page.getViewport({ scale: 1 })
        if (viewport.rotation % 360 !== 0 || viewport.width <= 0 || viewport.height <= 0) continue
        const scaleX = pageSize[0] > 0 ? pageSize[0] / viewport.width : 1
        const scaleY = pageSize[1] > 0 ? pageSize[1] / viewport.height : 1
        const content = await page.getTextContent()
        const items: TextLayerItem[] = []
        for (const item of content.items) {
          if (!('str' in item) || !item.str) continue
          const [a, b, c, d, x, y] = Util.transform(viewport.transform, item.transform) as number[]
          const height = Math.hypot(c!, d!)
          // Horizontal runs only: skewed or vertical text has no reliable box.
          if (height <= 0 || Math.abs(b!) > 0.01 * Math.abs(a!) || Math.abs(c!) > 0.01 * height) continue
          items.push({
            text: item.str,
            bbox: [x! * scaleX, (y! - 0.8 * height) * scaleY, (x! + item.width) * scaleX, (y! + 0.2 * height) * scaleY]
          })
        }
        result.push({ pageIndex, items })
        page.cleanup()
      } catch {
        // An unreadable page keeps the parser text.
      }
    }
    return result
  } finally {
    await task.destroy().catch(() => undefined)
  }
}
