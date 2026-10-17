import React from 'react'
import { acquirePdfDocument } from './pdfDocumentCache'
import { renderDocumentRegion } from './components/ReaderFigureSnapshot'
import type { ReaderFigureGeometry } from '@shared/readerFigureGroups'

function pngBase64(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (!blob) { reject(new Error('无法编码整图')); return }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('无法读取整图'))
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1]!)
    reader.readAsDataURL(blob)
  }, 'image/png'))
}

/** Shared by the reader and archive: newly imported papers need crops before either view exists. */
export async function ensureFigureArtifacts(documentId: string, pdfUrl: string,
  geometries: readonly ReaderFigureGeometry[], signal: AbortSignal,
  onProgress?: (available: number, failed: number, total: number) => void): Promise<{ available: number; failed: number }> {
  const persist = window.copilotix?.cacheDocumentFigure
  const figures = geometries.filter(geometry => geometry.status === 'complete')
  const result = { available: 0, failed: 0 }
  if (!persist || !figures.length) return result
  let handle: ReturnType<typeof acquirePdfDocument> | undefined
  const release = (): void => handle?.release()
  signal.addEventListener('abort', release, { once: true })
  try {
    for (const geometry of figures) {
      signal.throwIfAborted()
      const request = { documentId, figureId: geometry.id,
        geometryKey: JSON.stringify([geometry.pageIndex, geometry.cropBox, geometry.pageSize]) }
      try {
        const existing = await persist(request)
        signal.throwIfAborted()
        if (existing.imagePath) { result.available++; onProgress?.(result.available, result.failed, figures.length); continue }
        handle ??= acquirePdfDocument(pdfUrl)
        const document = await handle.promise
        signal.throwIfAborted()
        const canvas = await renderDocumentRegion(document, geometry, 1800, signal)
        try {
          const png = await pngBase64(canvas)
          signal.throwIfAborted()
          const saved = await persist({ ...request, sourceRevision: existing.sourceRevision, pngBase64: png })
          if (saved.imagePath) result.available++
          else result.failed++
        } finally { canvas.width = 0; canvas.height = 0 }
      } catch (error) {
        signal.throwIfAborted()
        result.failed++
        console.warn('整图文件暂未生成', geometry.id, error)
      }
      onProgress?.(result.available, result.failed, figures.length)
      await new Promise(resolve => window.setTimeout(resolve, 32))
    }
    return result
  } finally {
    signal.removeEventListener('abort', release)
    release()
  }
}

/** Materialize all reliable figures once per paper, including figures below the viewport. */
export function useFigureArtifacts(documentId: string, pdfUrl: string | undefined, geometries: readonly ReaderFigureGeometry[]): void {
  React.useEffect(() => {
    if (!pdfUrl || !geometries.length) return
    const controller = new AbortController()
    void ensureFigureArtifacts(documentId, pdfUrl, geometries, controller.signal)
      .catch(error => { if (!controller.signal.aborted) console.warn('整图文件生成中断', error) })
    return () => controller.abort()
  }, [documentId, pdfUrl, geometries])
}
