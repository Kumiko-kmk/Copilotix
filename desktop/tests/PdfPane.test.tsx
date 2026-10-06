// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlockMapping, BlockSelection } from '@shared/types'

const { getDocumentMock } = vi.hoisted(() => ({ getDocumentMock: vi.fn() }))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: getDocumentMock
}))

import PdfPane, {
  buildPdfPageLayout,
  indexMappingsByPage,
  pageIndexAtOffset,
  pdfCanvasOutput,
  pdfPageMetrics,
  pdfRenderWindow,
  readPdfContentWidth
} from '../src/renderer/components/PdfPane'

let scrollIntoView: ReturnType<typeof vi.fn>

class IntersectionObserverMock {
  observe(): void {}
  disconnect(): void {}
}

class ResizeObserverMock {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  scrollIntoView = vi.fn()
  vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView
  })
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({})
  })

  const page = {
    cleanup: vi.fn(),
    getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
  }
  const document = {
    numPages: 2,
    getPage: vi.fn(async () => page),
    destroy: vi.fn(async () => undefined)
  }
  getDocumentMock.mockReturnValue({
    onProgress: null,
    onPassword: null,
    promise: Promise.resolve(document),
    destroy: vi.fn(async () => undefined)
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('PdfPane mapping navigation', () => {
  it('links text source/continuation boxes in both directions and preserves image selection', async () => {
    const onSelect = vi.fn()
    const mappings: BlockMapping[] = [
      {
        id: 'text-block',
        order: 0,
        type: 'text',
        sourceText: 'A paragraph continued on the next page',
        boxes: [
          { pageIndex: 0, pageSize: [612, 792], bbox: [10, 20, 300, 80], blockPosition: '0-0', mergeRole: 'source' },
          { pageIndex: 1, pageSize: [612, 792], bbox: [10, 30, 300, 90], blockPosition: '1-0', mergeRole: 'continuation' }
        ]
      },
      {
        id: 'image-block',
        order: 1,
        type: 'image',
        sourceText: '',
        sourceAsset: 'images/figure.png',
        boxes: [{ pageIndex: 0, pageSize: [612, 792], bbox: [20, 100, 400, 300], blockPosition: '0-1' }]
      }
    ]
    const view = render(
      <PdfPane url="copilotix-asset://document/original.pdf" mappings={mappings} selection={null} onSelect={onSelect} />
    )

    await waitFor(() => expect(view.container.querySelectorAll('[data-block-id]').length).toBe(3))
    expect(getDocumentMock).toHaveBeenCalledWith({
      url: 'copilotix-asset://document/original.pdf',
      rangeChunkSize: 128 * 1024,
      canvasMaxAreaInBytes: 32 * 1024 * 1024
    })
    const continuation = view.container.querySelector<HTMLElement>('[data-block-position="1-0"]')!
    fireEvent.click(continuation)
    expect(onSelect).toHaveBeenLastCalledWith({ mappingId: 'text-block', blockPosition: '1-0', origin: 'pdf' })

    const image = view.container.querySelector<HTMLElement>('[data-block-id="image-block"]')!
    fireEvent.click(image)
    expect(onSelect).toHaveBeenLastCalledWith({ mappingId: 'image-block', blockPosition: '0-1', origin: 'pdf' })

    const selection: BlockSelection = { mappingId: 'text-block', blockPosition: '1-0', origin: 'markdown' }
    view.rerender(
      <PdfPane url="copilotix-asset://document/original.pdf" mappings={mappings} selection={selection} onSelect={onSelect} />
    )
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'smooth', block: 'center', inline: 'nearest' })
    expect(continuation.classList.contains('active')).toBe(true)

    // Citations from the chat tab scroll the PDF exactly like Markdown clicks.
    scrollIntoView.mockClear()
    view.rerender(
      <PdfPane url="copilotix-asset://document/original.pdf" mappings={mappings} selection={{ mappingId: 'image-block', origin: 'citation' }} onSelect={onSelect} />
    )
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    expect(image.classList.contains('active')).toBe(true)
  })

  it('reveals only the overflowing scrollbar nearest the pointer edge', () => {
    const view = render(
      <PdfPane url="copilotix-asset://document/original.pdf" mappings={[]} selection={null} onSelect={vi.fn()} />
    )
    const scroller = view.container.querySelector<HTMLElement>('.pdf-scroll')!
    setScrollerMetrics(scroller, { clientWidth: 400, clientHeight: 300, scrollWidth: 800, scrollHeight: 900 })

    fireEvent.pointerMove(scroller, { clientX: 200, clientY: 150 })
    expect(scroller.classList.contains('pdf-scrollbar-x-visible')).toBe(false)
    expect(scroller.classList.contains('pdf-scrollbar-y-visible')).toBe(false)

    fireEvent.pointerMove(scroller, { clientX: 390, clientY: 150 })
    expect(scroller.classList.contains('pdf-scrollbar-x-visible')).toBe(false)
    expect(scroller.classList.contains('pdf-scrollbar-y-visible')).toBe(true)

    fireEvent.pointerMove(scroller, { clientX: 200, clientY: 290 })
    expect(scroller.classList.contains('pdf-scrollbar-x-visible')).toBe(true)
    expect(scroller.classList.contains('pdf-scrollbar-y-visible')).toBe(false)

    setScrollerMetrics(scroller, { clientWidth: 400, clientHeight: 300, scrollWidth: 400, scrollHeight: 300 })
    fireEvent.pointerMove(scroller, { clientX: 399, clientY: 299 })
    expect(scroller.classList.contains('pdf-scrollbar-x-visible')).toBe(false)
    expect(scroller.classList.contains('pdf-scrollbar-y-visible')).toBe(false)
  })

  it('delays hiding near-edge scrollbars and keeps them visible while dragging', () => {
    vi.useFakeTimers()
    try {
      const view = render(
        <PdfPane url="copilotix-asset://document/original.pdf" mappings={[]} selection={null} onSelect={vi.fn()} />
      )
      const scroller = view.container.querySelector<HTMLElement>('.pdf-scroll')!
      setScrollerMetrics(scroller, { clientWidth: 400, clientHeight: 300, scrollWidth: 800, scrollHeight: 900 })

      fireEvent.pointerMove(scroller, { clientX: 390, clientY: 150 })
      fireEvent.pointerMove(scroller, { clientX: 200, clientY: 150 })
      act(() => vi.advanceTimersByTime(299))
      expect(scroller.classList.contains('pdf-scrollbar-y-visible')).toBe(true)
      act(() => vi.advanceTimersByTime(1))
      expect(scroller.classList.contains('pdf-scrollbar-y-visible')).toBe(false)

      fireEvent.pointerMove(scroller, { clientX: 390, clientY: 150 })
      fireEvent.pointerDown(scroller)
      fireEvent.pointerMove(scroller, { clientX: 200, clientY: 150 })
      act(() => vi.advanceTimersByTime(500))
      expect(scroller.classList.contains('pdf-scrollbar-y-visible')).toBe(true)
      fireEvent.pointerUp(window)
      act(() => vi.advanceTimersByTime(300))
      expect(scroller.classList.contains('pdf-scrollbar-y-visible')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('PDF fit-width zoom', () => {
  it('treats the available reader width as 100%', () => {
    expect(pdfPageMetrics({ width: 612, height: 792 }, 500, 1)).toEqual({
      scale: 500 / 612,
      width: 500,
      height: 792 * 500 / 612
    })
    expect(pdfPageMetrics({ width: 400, height: 600 }, 500, 1.1).width).toBeCloseTo(550)
  })

  it('handles different page sizes, zoom limits and an unavailable width', () => {
    expect(pdfPageMetrics({ width: 300, height: 900 }, 450, 1).height).toBe(1350)
    expect(pdfPageMetrics({ width: 612, height: 792 }, 0, 1).width).toBe(612)
    expect(pdfPageMetrics({ width: 612, height: 792 }, 500, 0.1).width).toBeCloseTo(300)
    expect(pdfPageMetrics({ width: 612, height: 792 }, 500, 3).width).toBeCloseTo(1000)
  })

  it('subtracts the scroll container inline padding', () => {
    const scroller = document.createElement('div')
    scroller.style.paddingLeft = '24px'
    scroller.style.paddingRight = '24px'
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 548 })
    document.body.append(scroller)
    expect(readPdfContentWidth(scroller)).toBe(500)
    scroller.remove()
  })

  it('bounds backing canvases by DPR, pixel area and browser-safe dimensions', () => {
    expect(pdfCanvasOutput(600, 800, 3)).toEqual({ width: 1200, height: 1600, scale: 2 })

    const large = pdfCanvasOutput(4000, 6000, 2)
    expect(large.width * large.height).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(large.width).toBeLessThanOrEqual(8192)
    expect(large.height).toBeLessThanOrEqual(8192)
    expect(large.scale).toBeLessThan(1)

    const veryWide = pdfCanvasOutput(20_000, 100, 1)
    expect(veryWide.width).toBeLessThanOrEqual(8192)
  })
})

describe('PDF long-document indexing', () => {
  it('keeps the heavy render window bounded for a thousand-page document', () => {
    expect(pdfRenderWindow(0, 1000, 1)).toEqual({ start: 0, end: 2 })
    expect(pdfRenderWindow(500, 1000, 1)).toEqual({ start: 499, end: 502 })
    expect(pdfRenderWindow(999, 1000, 1)).toEqual({ start: 998, end: 1000 })
  })

  it('locates pages by binary-searchable cumulative geometry', () => {
    const layout = buildPdfPageLayout(Array.from({ length: 1000 }, () => ({ width: 600, height: 800 })), 600, 1)
    expect(layout.totalHeight).toBe(824_000)
    expect(pageIndexAtOffset(layout, 0)).toBe(0)
    expect(pageIndexAtOffset(layout, 824 * 500 + 20)).toBe(500)
    expect(pageIndexAtOffset(layout, layout.totalHeight)).toBe(999)
  })

  it('indexes mappings once by every page they touch', () => {
    const mapping: BlockMapping = {
      id: 'continued',
      order: 0,
      type: 'text',
      sourceText: 'continued text',
      boxes: [
        { pageIndex: 2, pageSize: [612, 792], bbox: [0, 0, 10, 10], blockPosition: '2-0' },
        { pageIndex: 3, pageSize: [612, 792], bbox: [0, 0, 10, 10], blockPosition: '3-0' }
      ]
    }
    const pages = indexMappingsByPage([mapping], 1000)
    expect(pages[0]).toEqual([])
    expect(pages[2]).toEqual([mapping])
    expect(pages[3]).toEqual([mapping])
    expect(pages[999]).toEqual([])
  })
})

function setScrollerMetrics(
  scroller: HTMLElement,
  metrics: { clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number }
): void {
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(scroller, key, { configurable: true, value })
  }
  vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({
    bottom: metrics.clientHeight,
    height: metrics.clientHeight,
    left: 0,
    right: metrics.clientWidth,
    top: 0,
    width: metrics.clientWidth,
    x: 0,
    y: 0,
    toJSON: () => ({})
  })
}
