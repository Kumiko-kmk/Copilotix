import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { detectRepositoryCoverPage, trustedPdfMetadataTitle, type CoverPageFinding } from '@shared/pdfImport'
import { pdfWorker } from './pdfDocumentCache'

/** Larger files are imported without a preview rather than copied into memory here. */
const MAX_INSPECTED_BYTES = 120 * 1024 * 1024

export type PdfFileInspection =
  | { status: 'ready'; pageCount: number; metadataTitle: string | null; cover: CoverPageFinding | null }
  | { status: 'encrypted' | 'unreadable' | 'too-large' }

/**
 * Reads what the import confirmation shows: page count, a usable metadata title and whether page 1
 * looks like a repository cover sheet. Runs on the shared pdf.js worker, entirely locally.
 */
export async function inspectPdfFile(file: File, signal: AbortSignal): Promise<PdfFileInspection> {
  if (file.size > MAX_INSPECTED_BYTES) return { status: 'too-large' }
  const data = new Uint8Array(await file.arrayBuffer())
  if (signal.aborted) return { status: 'unreadable' }
  const task = pdfjs.getDocument({ data, worker: pdfWorker(), stopAtErrors: false })
  let encrypted = false
  task.onPassword = () => {
    encrypted = true
    void task.destroy()
  }
  const abort = (): void => { void task.destroy() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const document = await task.promise
    const pageCount = document.numPages
    const { info, metadata } = await document.getMetadata().catch(() => ({ info: {}, metadata: null }))
    const infoTitle = typeof (info as { Title?: unknown }).Title === 'string' ? (info as { Title: string }).Title : null
    const metadataTitle = trustedPdfMetadataTitle(infoTitle, file.name) ?? trustedPdfMetadataTitle(metadata?.get('dc:title'), file.name)
    let cover: CoverPageFinding | null = null
    if (pageCount >= 2) {
      const content = await (await document.getPage(1)).getTextContent()
      const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
      cover = detectRepositoryCoverPage(text, pageCount)
    }
    return { status: 'ready', pageCount, metadataTitle, cover }
  } catch {
    return { status: encrypted ? 'encrypted' : 'unreadable' }
  } finally {
    signal.removeEventListener('abort', abort)
    void task.destroy()
  }
}
