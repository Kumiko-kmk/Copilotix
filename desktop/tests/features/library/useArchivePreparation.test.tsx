// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PaperInsightSource, PaperInsightState } from '@features/insight/contract/paperInsight'
import { useArchivePreparation } from '../../../src/features/library/renderer/archive/useArchivePreparation'
import type { ArchivePaper } from '../../../src/features/library/renderer/archive/archiveShelves'
const mocks = vi.hoisted(() => ({ data: undefined as unknown, crop: vi.fn(), cover: vi.fn(async () => ({ canvas: {}, pages: 1 })) }))
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: mocks.data }) }))
vi.mock('@shared/readerFigureGroups', () => ({ buildReaderFigureGeometries: () => [{ id: 'figure', status: 'complete' }] }))
vi.mock('../../../src/renderer/useFigureArtifacts', () => ({ ensureFigureArtifacts: mocks.crop }))
vi.mock('../../../src/features/library/renderer/archive/ArchiveDetail', () => ({ renderSpread: mocks.cover }))
vi.mock('../../../src/features/library/renderer/archive/detailPage', () => ({ loadDetailPage: (_key: string, create: () => Promise<unknown>) => create(), firstPageRenderer: () => vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
function fixture(id = crypto.randomUUID()) {
  mocks.data = { markdown: 'Original paper', mappings: [], layoutJson: '{}', pdfUrl: 'https://local/'+id, summary: { updatedAt: '2026-10-16', workflow: { status: 'completed' } } }
  let emit!: (id: string, state: PaperInsightState) => void
  const ready = { status: 'ready', stale: false } as PaperInsightState
  const source: PaperInsightSource = { get: vi.fn(async () => ready), generate: vi.fn(), subscribe: listener => { emit = listener; return vi.fn() } }
  const paper: ArchivePaper = { id, displayName: 'Paper', originalName: 'paper.pdf', createdAt: '2026-10-16', workflow: { status: 'completed', progress: 100, activeJobKind: null, error: null } }
  return { paper, source, emit: (state: PaperInsightState) => emit(id, state) }
}
it('waits for figures and saved analysis, and never treats a workflow 100% as archive readiness', async () => {
  const f = fixture()
  let finish!: (value: { available: number; failed: number }) => void
  mocks.crop.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const view = renderHook(() => useArchivePreparation(f.paper, f.source))
  await waitFor(() => expect(mocks.crop).toHaveBeenCalledOnce())
  expect(view.result.current.ready).toBe(false)
  expect(view.result.current.progress).toBeLessThan(100)
  act(() => f.emit({ status: 'generating' }))
  await act(async () => finish({ available: 1, failed: 0 }))
  expect(view.result.current).toMatchObject({ ready: false, waiting: 'analysis' })
  act(() => f.emit({ status: 'ready', stale: false } as PaperInsightState))
  await waitFor(() => expect(view.result.current).toEqual({ ready: true, progress: 100, waiting: null }))
})
it('keeps failed figures and partial translations locked', async () => {
  const f = fixture()
  mocks.crop.mockResolvedValue({ available: 0, failed: 1 })
  const view = renderHook(() => useArchivePreparation(f.paper, f.source))
  await waitFor(() => expect(mocks.crop).toHaveBeenCalledOnce())
  expect(view.result.current.ready).toBe(false)
  f.paper.workflow.status = 'partial'
  view.rerender()
  expect(view.result.current.progress).toBeLessThan(100)
})
it('waits for the laid-out cover even after analysis and crop files are ready', async () => {
  const f = fixture()
  mocks.crop.mockResolvedValue({ available: 1, failed: 0 })
  let finish!: (page: { canvas: object; pages: number }) => void
  mocks.cover.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = renderHook(() => useArchivePreparation(f.paper, f.source))
  await waitFor(() => expect(mocks.cover).toHaveBeenCalledOnce())
  expect(view.result.current.ready).toBe(false)
  await act(async () => finish({ canvas: {}, pages: 1 }))
  expect(view.result.current.ready).toBe(true)
})
it('reports the figures step only while crops are rendered, not while cached ones are checked', async () => {
  const f = fixture()
  let finish!: (value: { available: number; failed: number }) => void
  let render!: () => void
  mocks.crop.mockImplementation((_id, _url, _geometries, _signal, _progress, onRender: () => void) => {
    render = onRender
    return new Promise(resolve => { finish = resolve })
  })
  const view = renderHook(() => useArchivePreparation(f.paper, f.source))
  await waitFor(() => expect(mocks.crop).toHaveBeenCalledOnce())
  await waitFor(() => expect(view.result.current).toMatchObject({ ready: false, waiting: null }))
  act(() => render())
  expect(view.result.current.waiting).toBe('figures')
  await act(async () => finish({ available: 1, failed: 0 }))
  await waitFor(() => expect(view.result.current).toEqual({ ready: true, progress: 100, waiting: null }))
})
it('aborts old selection preparation and ignores its late completion', async () => {
  const f = fixture()
  let finish!: (value: { available: number; failed: number }) => void
  mocks.crop.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue({ available: 0, failed: 1 })
  const view = renderHook(({ paper }) => useArchivePreparation(paper, f.source), { initialProps: { paper: f.paper } })
  await waitFor(() => expect(mocks.crop).toHaveBeenCalledOnce())
  const signal = mocks.crop.mock.calls[0]![3] as AbortSignal
  view.rerender({ paper: { ...f.paper, id: crypto.randomUUID() } })
  expect(signal.aborted).toBe(true)
  await act(async () => finish({ available: 1, failed: 0 }))
  expect(view.result.current.ready).toBe(false)
})
it('prepares only the paper the selection rests on, not those passed while browsing', async () => {
  const f = fixture()
  mocks.crop.mockResolvedValue({ available: 1, failed: 0 })
  const passed = { ...f.paper, id: crypto.randomUUID() }
  const resting = { ...f.paper, id: crypto.randomUUID() }
  const view = renderHook(({ paper }) => useArchivePreparation(paper, f.source), { initialProps: { paper: f.paper } })
  view.rerender({ paper: passed })
  view.rerender({ paper: resting })
  await waitFor(() => expect(mocks.crop).toHaveBeenCalledOnce())
  await new Promise(resolve => setTimeout(resolve, 600))
  expect(mocks.crop).toHaveBeenCalledOnce()
  expect(mocks.crop.mock.calls[0]![0]).toBe(resting.id)
})
