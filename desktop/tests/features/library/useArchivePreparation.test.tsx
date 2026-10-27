// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArchiveInsightSnapshot, PaperInsightSource, PaperInsightState } from '@features/insight/contract/paperInsight'
import { archivePreparation, useArchivePreparation } from '../../../src/features/library/renderer/archive/useArchivePreparation'
import { useArchiveCatalog } from '../../../src/features/library/renderer/archive/useArchiveCatalog'
import type { ArchivePaper } from '../../../src/features/library/renderer/archive/archiveShelves'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return ({ children }: React.PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
function paper(): ArchivePaper {
  return { id: crypto.randomUUID(), displayName: 'Paper', originalName: 'paper.pdf', sourceHash: 'source-hash',
    createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z',
    workflow: { status: 'completed', progress: 100, activeJobKind: null, error: null } }
}
function saved(paper: ArchivePaper, patch: Partial<ArchiveInsightSnapshot> = {}): ArchiveInsightSnapshot {
  return { documentId: paper.id, updatedAt: paper.updatedAt ?? paper.createdAt, workflowStatus: paper.workflow.status,
    savedStatus: 'ready', ready: true, translatedTitle: '已保存的译名', keywords: ['机制'], tldr: '已保存的论文总结。', ...patch }
}
function savedState(): PaperInsightState {
  return { status: 'ready', stale: false, insight: { summary: '已保存的论文总结。', researchQuestion: '问题', method: '方法',
    contributions: [], findings: [], limitations: [], keywords: ['机制'], model: { provider: 'deepseek', name: 'deepseek-flash' },
    generatedAt: '2026-10-26T00:00:00Z', sourceRevision: 'persisted-source' } }
}
function sourceFor(papers: ArchivePaper[]) {
  const listeners = new Set<(id: string, state: PaperInsightState) => void>()
  const list = vi.fn<NonNullable<PaperInsightSource['list']>>(async ids => ids.flatMap(id => {
    const value = papers.find(paper => paper.id === id)
    return value ? [saved(value)] : []
  }))
  const source: PaperInsightSource = { list, get: vi.fn(async () => savedState()), generate: vi.fn(async () => undefined),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  return { source, list, emit: (id: string, state: PaperInsightState) => listeners.forEach(listener => listener(id, state)) }
}
function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

describe('archive access uses durable saved facts', () => {
  it('requires the validated saved card even when workflow progress is already 100%', () => {
    const value = paper()
    expect(archivePreparation(value, undefined, true)).toMatchObject({ ready: false, waiting: 'analysis' })
    for (const status of ['missing', 'stale', 'failed'] as const) {
      const state = archivePreparation(value, saved(value, { savedStatus: status, ready: false }), true)
      expect(state.ready).toBe(false)
      expect(state.progress).toBeLessThan(100)
      expect(state.waiting).toBe(status === 'failed' ? 'analysis-failed' : 'analysis')
    }
    expect(archivePreparation(value, saved(value), true)).toEqual({ ready: true, progress: 100, waiting: null })
  })

  it('keeps partial or active processing locked despite an older saved card and 100% progress', () => {
    const original = paper()
    for (const status of ['translating', 'partial', 'failed'] as const) {
      const value = { ...original, workflow: { ...original.workflow, status, progress: 100 } }
      const result = archivePreparation(value, saved(original), true)
      expect(result.ready).toBe(false)
      expect(result.progress).toBeLessThan(100)
      expect(result.waiting).toBe('workflow')
    }
    expect(archivePreparation(null, undefined, true).ready).toBe(false)
  })

  it('preserves the legacy embedder fallback when no insight source is supplied', () => {
    expect(archivePreparation(paper(), undefined, false)).toEqual({ ready: true, progress: 100, waiting: null })
    const value = paper()
    value.workflow.status = 'partial'
    expect(archivePreparation(value, undefined, false).ready).toBe(false)
  })
})

describe('saved catalog updates and selection races', () => {
  it('rechecks a missing card generated while the library page was unmounted', async () => {
    const value = paper(), f = sourceFor([value]), provider = wrapper()
    f.list.mockResolvedValueOnce([saved(value, { savedStatus: 'missing', ready: false })])
    const first = renderHook(() => useArchiveCatalog([value], f.source), { wrapper: provider })
    await waitFor(() => expect(first.result.current.get(value.id)?.savedStatus).toBe('missing'))
    first.unmount()
    // The default source now returns a saved card, with no document timestamp
    // change and no subscriber around to receive the generation event.
    const returned = renderHook(() => useArchiveCatalog([value], f.source), { wrapper: provider })
    await waitFor(() => expect(returned.result.current.get(value.id)?.ready).toBe(true))
    expect(f.list).toHaveBeenCalledTimes(2)
    expect(f.source.generate).not.toHaveBeenCalled()
  })

  it('loads all saved facts once so arbitrary paper switches stay ready without body or crop work', async () => {
    const papers = [paper(), paper(), paper()]
    const f = sourceFor(papers)
    const view = renderHook(({ selected }) => {
      const catalog = useArchiveCatalog(papers, f.source)
      return archivePreparation(selected, catalog.get(selected.id), true)
    }, { initialProps: { selected: papers[0]! }, wrapper: wrapper() })
    await waitFor(() => expect(view.result.current.ready).toBe(true))
    view.rerender({ selected: papers[2]! })
    expect(view.result.current.ready).toBe(true)
    view.rerender({ selected: papers[1]! })
    expect(view.result.current.ready).toBe(true)
    expect(f.list).toHaveBeenCalledOnce()
    expect(f.list).toHaveBeenCalledWith(papers.map(paper => paper.id))
    expect(f.source.get).not.toHaveBeenCalled()
    expect(f.source.generate).not.toHaveBeenCalled()
  })

  it('does not transiently disable a saved mature card while its replacement generates or fails', async () => {
    const value = paper(), f = sourceFor([value])
    const view = renderHook(() => useArchivePreparation(value, f.source), { wrapper: wrapper() })
    await waitFor(() => expect(view.result.current.ready).toBe(true))
    const recheck = pending<ArchiveInsightSnapshot[]>()
    f.list.mockReturnValueOnce(recheck.promise)
    act(() => f.emit(value.id, { status: 'generating' }))
    expect(view.result.current.ready).toBe(true)
    await waitFor(() => expect(f.list).toHaveBeenCalledTimes(2))
    await act(async () => { recheck.resolve([saved(value)]) })
    act(() => f.emit(value.id, { status: 'failed', error: 'replacement failed' }))
    expect(view.result.current.ready).toBe(true)
    await waitFor(() => expect(f.list).toHaveBeenCalledTimes(3))
    expect(view.result.current.ready).toBe(true)
  })

  it('rejects a late initial missing row after a newer saved-state event has already unlocked the card', async () => {
    const value = paper(), f = sourceFor([value])
    const initial = pending<ArchiveInsightSnapshot[]>()
    f.list.mockReturnValueOnce(initial.promise)
    const view = renderHook(() => useArchivePreparation(value, f.source), { wrapper: wrapper() })
    await waitFor(() => expect(f.list).toHaveBeenCalledOnce())
    act(() => f.emit(value.id, { status: 'generating' }))
    await waitFor(() => expect(view.result.current.ready).toBe(true))
    await act(async () => { initial.resolve([saved(value, { savedStatus: 'missing', ready: false })]) })
    expect(view.result.current.ready).toBe(true)
    expect(f.source.get).not.toHaveBeenCalled()
  })

  it('rejects a completed old revision and accepts only the newly selected saved revision', async () => {
    const original = paper(), f = sourceFor([original])
    const older = pending<ArchiveInsightSnapshot[]>(), newer = pending<ArchiveInsightSnapshot[]>()
    f.list.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const view = renderHook(({ selected }) => useArchivePreparation(selected, f.source), {
      initialProps: { selected: original }, wrapper: wrapper()
    })
    await waitFor(() => expect(f.list).toHaveBeenCalledOnce())
    const changed = { ...original, updatedAt: '2026-10-27T00:00:00Z' }
    view.rerender({ selected: changed })
    await waitFor(() => expect(f.list).toHaveBeenCalledTimes(2))
    await act(async () => { older.resolve([saved(original)]) })
    expect(view.result.current.ready).toBe(false)
    await act(async () => { newer.resolve([saved(changed)]) })
    expect(view.result.current).toEqual({ ready: true, progress: 100, waiting: null })
  })

  it('immediately reflects a valid newly saved card while its follow-up local verification is pending', async () => {
    const value = paper(), f = sourceFor([value])
    f.list.mockResolvedValueOnce([saved(value, { savedStatus: 'missing', ready: false })])
    const view = renderHook(() => useArchivePreparation(value, f.source), { wrapper: wrapper() })
    await waitFor(() => expect(f.list).toHaveBeenCalledOnce())
    const recheck = pending<ArchiveInsightSnapshot[]>()
    f.list.mockReturnValueOnce(recheck.promise)
    act(() => f.emit(value.id, savedState()))
    expect(view.result.current.ready).toBe(true)
    await act(async () => { recheck.resolve([saved(value)]) })
    expect(view.result.current.ready).toBe(true)
  })
})
