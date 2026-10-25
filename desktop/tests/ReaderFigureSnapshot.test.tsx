// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { renderDocumentRegion, figurePixelSize, FIGURE_MAX_PIXELS, FIGURE_MAX_EDGE } from '../src/renderer/components/ReaderFigureSnapshot'

vi.mock('../src/platform/pdf/renderer/pdfDocumentCache', () => ({ acquirePdfDocument: vi.fn() }))

afterEach(() => vi.restoreAllMocks())

describe('reader figure PDF snapshot', () => {
  it('renders only the mapped crop at a bounded pixel width', async () => {
    const context = {}
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => context) as unknown as HTMLCanvasElement['getContext'])
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
    expect(canvas.height).toBe(375)
    expect(getViewport).toHaveBeenCalledWith({ scale })
    expect(render).toHaveBeenCalledWith(expect.objectContaining({
      canvas,
      canvasContext: context,
      transform: [1, 0, 0, 1, -105 * scale, -514 * scale]
    }))
  })

  it.each([[500, 50000], [50000, 500], [4000, 4000], [100, 500]])('bounds long and large crops (%s × %s)', (width, height) => {
    const [pixelsX, pixelsY] = figurePixelSize(width, height, 2400)
    expect(pixelsX * pixelsY).toBeLessThanOrEqual(FIGURE_MAX_PIXELS)
    expect(Math.max(pixelsX, pixelsY)).toBeLessThanOrEqual(FIGURE_MAX_EDGE)
    expect(Math.min(pixelsX, pixelsY)).toBeGreaterThan(0)
  })

  it('uses displayed page coordinates for rotated pages', async () => {
    const context = {}
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => context) as unknown as HTMLCanvasElement['getContext'])
    const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
    const document = { getPage: vi.fn(async () => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 792 * scale, height: 612 * scale, rotation: 90 }),
      render
    })) } as unknown as PDFDocumentProxy
    const canvas = await renderDocumentRegion(document, { pageIndex: 0, pageSize: [792, 612], cropBox: [100, 50, 500, 250] }, 800)
    expect([canvas.width, canvas.height]).toEqual([800, 400])
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ transform: [1, 0, 0, 1, -200, -100] }))
  })
})
