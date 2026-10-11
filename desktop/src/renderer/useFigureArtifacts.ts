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

/** Materialize all reliable figures once per paper, including figures below the viewport. */
export function useFigureArtifacts(documentId: string, pdfUrl: string | undefined, geometries: readonly ReaderFigureGeometry[]): void {
  React.useEffect(() => {
    const persist = window.copilotix?.cacheDocumentFigure
    const figures = geometries.filter(geometry => geometry.status === 'complete')
    if (!persist || !pdfUrl || !figures.length) return
    const controller = new AbortController()
    const signal = controller.signal
    let handle: ReturnType<typeof acquirePdfDocument> | undefined
    const release = (): void => handle?.release()
    signal.addEventListener('abort', release, { once: true })
    void (async () => {
      for (const geometry of figures) {
        signal.throwIfAborted()
        const request = { documentId, figureId: geometry.id,
          geometryKey: JSON.stringify([geometry.pageIndex, geometry.cropBox, geometry.pageSize]) }
        try {
          const existing = await persist(request)
          signal.throwIfAborted()
          if (existing.imagePath) continue
          handle ??= acquirePdfDocument(pdfUrl)
          const document = await handle.promise
          signal.throwIfAborted()
          const canvas = await renderDocumentRegion(document, geometry, 1800, signal)
          try {
            const png = await pngBase64(canvas)
            signal.throwIfAborted()
            await persist({ ...request, sourceRevision: existing.sourceRevision, pngBase64: png })
          } finally { canvas.width = 0; canvas.height = 0 }
        } catch (error) {
          if (signal.aborted) return
          // A failed derived asset never hides a source or blocks reading. Retry
          // on the next open instead of caching a permanent failure.
          console.warn('整图文件暂未生成', geometry.id, error)
        }
        await new Promise(resolve => window.setTimeout(resolve, 32))
      }
    })().catch(error => { if (!signal.aborted) console.warn('整图文件生成中断', error) }).finally(() => {
      signal.removeEventListener('abort', release)
      release()
    })
    return () => controller.abort()
  }, [documentId, pdfUrl, geometries])
}
