import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString()

interface PdfProgress { loaded: number; total: number }
interface PdfCallbacks {
  onProgress?(progress: PdfProgress): void
  onPassword?(): void
}
interface CacheEntry {
  task: PDFDocumentLoadingTask
  promise: Promise<PDFDocumentProxy>
  references: number
  callbacks: Set<PdfCallbacks>
}

const entries = new Map<string, CacheEntry>()
const PDF_RANGE_CHUNK_SIZE = 128 * 1024
const PDF_IMAGE_CANVAS_MAX_BYTES = 32 * 1024 * 1024

export interface PdfDocumentHandle {
  promise: Promise<PDFDocumentProxy>
  release(): void
}

export function acquirePdfDocument(url: string, callbacks: PdfCallbacks = {}): PdfDocumentHandle {
  let entry = entries.get(url)
  if (!entry) {
    const task = pdfjs.getDocument({
      url,
      rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
      canvasMaxAreaInBytes: PDF_IMAGE_CANVAS_MAX_BYTES
    })
    entry = { task, promise: task.promise, references: 0, callbacks: new Set() }
    const stableEntry = entry
    task.onProgress = (progress) => stableEntry.callbacks.forEach((listener) => listener.onProgress?.(progress))
    task.onPassword = () => {
      stableEntry.callbacks.forEach((listener) => listener.onPassword?.())
      void task.destroy()
    }
    entries.set(url, entry)
  }
  entry.references += 1
  entry.callbacks.add(callbacks)
  let released = false
  return {
    promise: entry.promise,
    release: () => {
      if (released) return
      released = true
      const current = entries.get(url)
      if (!current) return
      current.callbacks.delete(callbacks)
      current.references -= 1
      if (current.references <= 0) {
        entries.delete(url)
        void current.task.destroy()
      }
    }
  }
}
