// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { acquirePdfDocument } from '../src/renderer/pdfDocumentCache'
import ReaderFigureSnapshot, { FIGURE_CACHE_BYTES, figureRegionCacheStats } from '../src/renderer/components/ReaderFigureSnapshot'
import type { ReaderFigureGroup } from '../src/renderer/readerFigureGroups'

vi.mock('../src/renderer/pdfDocumentCache', () => ({ acquirePdfDocument: vi.fn() }))
const group: ReaderFigureGroup = {
  id: 'figure', pageIndex: 0, pageSize: [612, 792], cropBox: [10, 20, 500, 700],
  mappingIds: ['a', 'caption'], assetSources: ['a.jpg'], captionMappingId: 'caption',
  fallbackLegendText: '', status: 'complete', reason: '', members: [],
  ownerBlockIndex: 0, captionBlockIndex: 1, memberBlockIndexes: [0, 1], captionMarkdown: 'Figure 1.'
}
let renderPdf: ReturnType<typeof vi.fn>
let release: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.clearAllMocks()
  renderPdf = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
  release = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ drawImage: vi.fn() })) as unknown as HTMLCanvasElement['getContext'])
  vi.mocked(acquirePdfDocument).mockImplementation(() => ({
    promise: Promise.resolve({ getPage: async () => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
      render: renderPdf
    }) } as unknown as PDFDocumentProxy), release
  }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('figure rendering lifecycle', () => {
  it('does not start a PDF crop until it approaches the scroll viewport', async () => {
    let notify: IntersectionObserverCallback = () => undefined
    const disconnect = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { notify = callback }
      observe = vi.fn()
      disconnect = disconnect
    })
    const onStateChange = vi.fn()
    const view = render(<ReaderFigureSnapshot pdfUrl="lazy.pdf" group={group} onRendered={() => undefined} onStateChange={onStateChange} />)
    expect(acquirePdfDocument).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-rendered="false"]')).not.toBeNull()
    act(() => notify([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver))
    await waitFor(() => expect(onStateChange).toHaveBeenCalledWith('ready'))
    expect(disconnect).toHaveBeenCalled()
  })

  it('retains a retry action after a failed crop and can recover', async () => {
    renderPdf.mockImplementationOnce(() => ({ promise: Promise.reject(new Error('decode failed')), cancel: vi.fn() }))
    const state = vi.fn()
    const view = render(<ReaderFigureSnapshot pdfUrl="retry.pdf" group={group} onRendered={() => undefined} onStateChange={state} />)
    await waitFor(() => expect(state).toHaveBeenCalledWith('failed'))
    expect(view.container.querySelector('[data-failed="true"]')).not.toBeNull()
    fireEvent.click(view.getByText('重试整图'))
    await waitFor(() => expect(state).toHaveBeenCalledWith('ready'))
    expect(view.container.querySelector('[data-failed="true"]')).toBeNull()
    expect(renderPdf).toHaveBeenCalledTimes(2)
  })

  it('cancels an old document crop and never reports its late result as ready', async () => {
    let reject: (reason: Error) => void = () => undefined
    const cancel = vi.fn(() => reject(new Error('cancelled')))
    renderPdf.mockImplementationOnce(() => ({
      promise: new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise }), cancel
    }))
    const oldState = vi.fn(), nextState = vi.fn()
    const view = render(<ReaderFigureSnapshot pdfUrl="old.pdf" group={group} onRendered={() => undefined} onStateChange={oldState} />)
    await waitFor(() => expect(renderPdf).toHaveBeenCalled())
    view.rerender(<ReaderFigureSnapshot pdfUrl="new.pdf" group={group} onRendered={() => undefined} onStateChange={nextState} />)
    await waitFor(() => expect(nextState).toHaveBeenCalledWith('ready'))
    expect(cancel).toHaveBeenCalled()
    expect(oldState).not.toHaveBeenCalledWith('ready')
    expect(release).toHaveBeenCalled()
  })

  it('evicts large completed crops by bytes rather than figure count', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(2400)
    for (let i = 0; i < 4; i++) {
      const state = vi.fn()
      const tall = { ...group, cropBox: [10, 20, 200, 700] as [number, number, number, number] }
      const view = render(<ReaderFigureSnapshot pdfUrl={'large-' + i + '.pdf'} group={tall} onRendered={() => undefined} onStateChange={state} />)
      await waitFor(() => expect(state).toHaveBeenCalledWith('ready'))
      expect(figureRegionCacheStats().bytes).toBeLessThanOrEqual(FIGURE_CACHE_BYTES)
      view.unmount()
    }
    expect(figureRegionCacheStats().entries).toBeLessThan(4)
  })
})
