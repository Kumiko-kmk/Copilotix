// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlockMapping, BlockSelection } from '@shared/types'

const { getDocumentMock } = vi.hoisted(() => ({ getDocumentMock: vi.fn() }))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: getDocumentMock
}))

import PdfPane from '../src/renderer/components/PdfPane'

let scrollIntoView: ReturnType<typeof vi.fn>

class IntersectionObserverMock {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  scrollIntoView = vi.fn()
  vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)
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
    expect(continuation.classList.contains('active')).toBe(true)
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
