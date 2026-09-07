// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { renderDocumentRegion } from '../src/renderer/components/ReaderFigureSnapshot'

vi.mock('../src/renderer/pdfDocumentCache', () => ({ acquirePdfDocument: vi.fn() }))

afterEach(() => vi.restoreAllMocks())

describe('reader figure PDF snapshot', () => {
  it('renders only the mapped crop at a bounded pixel width', async () => {
    const context = {}
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D)
    const render = vi.fn(() => ({ promise: Promise.resolve() }))
    const getViewport = vi.fn(({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }))
    const document = {
      getPage: vi.fn(async () => ({ getViewport, render }))
    } as unknown as PDFDocumentProxy

    const canvas = await renderDocumentRegion(document, {
      pageIndex: 11,
      cropBox: [105, 514, 504, 639]
    })
    const scale = 1_200 / 399

    expect(document.getPage).toHaveBeenCalledWith(12)
    expect(canvas.width).toBe(1_200)
    expect(canvas.height).toBe(376)
    expect(getViewport).toHaveBeenCalledWith({ scale })
    expect(render).toHaveBeenCalledWith(expect.objectContaining({
      canvas,
      canvasContext: context,
      transform: [1, 0, 0, 1, -105 * scale, -514 * scale]
    }))
  })
})
