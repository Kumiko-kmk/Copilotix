import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArchivePaper } from '../../../src/features/library/renderer/archive/archiveShelves'
import type { StoredArchiveCover } from '../../../src/features/library/renderer/archive/archiveCoverStore'

const mocked = vi.hoisted(() => ({ source: vi.fn(), render: vi.fn(), document: vi.fn(), read: vi.fn(), write: vi.fn(), decode: vi.fn(), encode: vi.fn() }))
vi.mock('../../../src/features/library/renderer/archive/archiveCover', () => ({ readArchiveCoverSource: mocked.source, renderArchiveCover: mocked.render }))
vi.mock('../../../src/features/library/renderer/archive/archiveBrowseData', () => ({
  archivePaperRevision: (paper: ArchivePaper) => `${paper.updatedAt ?? paper.createdAt}:${paper.workflow.status}`,
  loadArchiveDocument: mocked.document
}))
vi.mock('../../../src/features/library/renderer/archive/archiveCoverStore', () => ({
  readStoredArchiveCover: mocked.read, writeStoredArchiveCover: mocked.write, decodeArchiveCover: mocked.decode, encodeArchiveCover: mocked.encode
}))
import { ArchiveCoverService } from '../../../src/features/library/renderer/archive/archiveCoverService'

function paper(id: string, updatedAt = '2026-10-26T00:00:00Z'): ArchivePaper {
  return { id, updatedAt, createdAt: updatedAt, sourceHash: `source-${id}`, originalName: `${id}.pdf`, displayName: id,
    workflow: { status: 'completed', progress: 100, activeJobKind: null, error: null } }
}
function canvas(width = 100, height = 80): HTMLCanvasElement { return { width, height, dataset: {} } as HTMLCanvasElement }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

const services: ArchiveCoverService[] = []
function service(): ArchiveCoverService { const result = new ArchiveCoverService(); services.push(result); return result }
let disk: Map<string, StoredArchiveCover>

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  disk = new Map()
  mocked.source.mockImplementation(async (value: ArchivePaper) => ({ fingerprint: `fingerprint-${value.id}`, hasManifest: true, figures: [] }))
  mocked.render.mockImplementation(async (value: ArchivePaper) => ({ canvas: canvas(), kind: 'spread', fingerprint: `fingerprint-${value.id}` }))
  mocked.document.mockResolvedValue({})
  mocked.read.mockImplementation(async (key: string) => disk.get(key) ?? null)
  mocked.write.mockImplementation(async (record: StoredArchiveCover) => { disk.set(record.key, record) })
  mocked.encode.mockResolvedValue(new Blob(['complete-cover']))
  mocked.decode.mockImplementation(async () => canvas())
})
afterEach(() => {
  services.splice(0).forEach(value => value.dispose())
  vi.useRealTimers()
})

describe('complete archive covers', () => {
  it('prepares every ready paper and promotes a non-neighbour before background work', async () => {
    const value = service()
    const papers = ['first', 'middle', 'last'].map(id => paper(id))
    value.sync(papers, new Set(papers.map(item => item.id)))
    value.prioritize('last')
    await vi.runAllTimersAsync()
    expect(mocked.render.mock.calls.map(call => call[0].id)).toEqual(['last', 'first', 'middle'])
    expect(disk.size).toBe(3)
    expect(mocked.document).toHaveBeenCalledTimes(3)
    const warm = value.peek(papers[2]!)!
    expect(warm.kind).toBe('spread')
    expect(warm.canvas.dataset.archiveCover).toBe('spread')
    expect(warm.canvas.dataset.archiveCoverKey).toBe(warm.key)
    warm.release()
    value.sync(papers, new Set(papers.map(item => item.id)))
    await vi.runAllTimersAsync()
    expect(mocked.render).toHaveBeenCalledTimes(3)
  })

  it('loads the final persisted spread without reading the body or generating crops again', async () => {
    const first = service(), item = paper('persisted')
    const requested = first.acquire(item, new AbortController().signal)
    await vi.runAllTimersAsync()
    const initial = await requested
    initial.release()
    first.dispose()
    mocked.render.mockClear()
    mocked.document.mockClear()
    const second = service()
    const loaded = second.acquire(item, new AbortController().signal)
    await vi.runAllTimersAsync()
    const cover = await loaded
    expect(mocked.decode).toHaveBeenCalledOnce()
    expect(mocked.render).not.toHaveBeenCalled()
    expect(mocked.document).not.toHaveBeenCalled()
    expect(cover.key).toBe(initial.key)
    expect(cover.canvas.dataset.archiveCoverKey).toBe(initial.key)
    cover.release()
  })

  it('evicts unpinned canvases at the byte budget and keeps scene pins alive through disposal', async () => {
    mocked.render.mockImplementation(async (value: ArchivePaper) => ({ canvas: canvas(2600, 2600), kind: 'spread', fingerprint: `fingerprint-${value.id}` }))
    const value = service()
    const firstRequest = value.acquire(paper('first'), new AbortController().signal)
    await vi.runAllTimersAsync()
    const first = await firstRequest
    const secondRequest = value.acquire(paper('second'), new AbortController().signal)
    await vi.runAllTimersAsync()
    const second = await secondRequest
    second.release()
    expect(second.canvas.width).toBe(0)
    expect(first.canvas.width).toBe(2600)
    value.dispose()
    expect(first.canvas.width).toBe(2600)
    first.release()
    first.release()
    expect(first.canvas.width).toBe(0)
  })

  it('cancels one caller without cancelling a shared preparation needed by another', async () => {
    const gate = deferred()
    mocked.render.mockImplementation(async (value: ArchivePaper) => {
      await gate.promise
      return { canvas: canvas(), kind: 'spread', fingerprint: `fingerprint-${value.id}` }
    })
    const value = service(), item = paper('shared')
    const controller = new AbortController()
    const first = value.acquire(item, controller.signal).then(() => 'ready', () => 'cancelled')
    const second = value.acquire(item, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(await first).toBe('cancelled')
    gate.resolve()
    await vi.runAllTimersAsync()
    const cover = await second
    expect(mocked.render).toHaveBeenCalledOnce()
    expect(cover.canvas.width).toBeGreaterThan(0)
    cover.release()
  })

  it('preempts unrelated background output and runs the clicked paper before the remaining library', async () => {
    const gate = deferred(), order: string[] = [], discarded = canvas()
    mocked.render.mockImplementation(async (value: ArchivePaper) => {
      order.push(value.id)
      if (order.length === 1) { await gate.promise; return { canvas: discarded, kind: 'spread', fingerprint: `fingerprint-${value.id}` } }
      return { canvas: canvas(), kind: 'spread', fingerprint: `fingerprint-${value.id}` }
    })
    const value = service(), papers = ['background', 'unrelated', 'clicked'].map(id => paper(id))
    value.sync(papers, new Set(papers.map(item => item.id)))
    await vi.advanceTimersByTimeAsync(80)
    const request = value.acquire(papers[2]!, new AbortController().signal)
    gate.resolve()
    await vi.runAllTimersAsync()
    const cover = await request
    expect(order.slice(0, 2)).toEqual(['background', 'clicked'])
    expect(discarded.width).toBe(0)
    expect(disk.size).toBe(3)
    cover.release()
  })

  it('replaces an unreadable persisted cover rather than retaining a corrupt hit forever', async () => {
    const first = service(), item = paper('corrupt')
    const request = first.acquire(item, new AbortController().signal)
    await vi.runAllTimersAsync()
    ;(await request).release()
    first.dispose()
    mocked.decode.mockRejectedValueOnce(new Error('bad bitmap'))
    mocked.write.mockClear()
    const second = service(), replacement = second.acquire(item, new AbortController().signal)
    await vi.runAllTimersAsync()
    ;(await replacement).release()
    expect(mocked.write).toHaveBeenCalledOnce()
  })

  it('rejects late output from an old revision and prepares its replacement separately', async () => {
    const gate = deferred(), oldCanvas = canvas()
    mocked.render.mockImplementationOnce(async () => { await gate.promise; return { canvas: oldCanvas, kind: 'spread', fingerprint: 'old' } })
    const value = service(), previous = paper('revised', 'old'), current = paper('revised', 'new')
    const old = value.acquire(previous, new AbortController().signal).then(() => 'ready', () => 'cancelled')
    await vi.advanceTimersByTimeAsync(0)
    value.sync([current], new Set([current.id]))
    expect(await old).toBe('cancelled')
    gate.resolve()
    await vi.runAllTimersAsync()
    expect(oldCanvas.width).toBe(0)
    expect(value.peek(previous)).toBeNull()
    const latest = value.peek(current)!
    expect(latest.key).toContain('new:completed')
    latest.release()
  })

  it('invalidates a changed saved figure fingerprint without clearing an already displayed pin', async () => {
    const value = service(), item = paper('weighted')
    value.sync([item], new Set([item.id]))
    await vi.runAllTimersAsync()
    const displayed = value.peek(item)!
    mocked.source.mockResolvedValue({ fingerprint: 'new-weights', hasManifest: true, figures: [] })
    mocked.render.mockResolvedValue({ canvas: canvas(), kind: 'spread', fingerprint: 'new-weights' })
    value.invalidate(item.id)
    expect(value.peek(item)).toBeNull()
    expect(displayed.canvas.width).toBeGreaterThan(0)
    await vi.runAllTimersAsync()
    const replacement = value.peek(item)!
    expect(replacement.key).not.toBe(displayed.key)
    displayed.release()
    expect(displayed.canvas.width).toBe(0)
    replacement.release()
  })

  it('does not cache a failure as a single-page cover and permits a fresh retry', async () => {
    mocked.source.mockRejectedValueOnce(new Error('source unavailable'))
    const value = service(), item = paper('retry')
    const failed = value.acquire(item, new AbortController().signal).then(() => 'ready', () => 'failed')
    await vi.runAllTimersAsync()
    expect(await failed).toBe('failed')
    expect(value.peek(item)).toBeNull()
    expect(mocked.write).not.toHaveBeenCalled()
    const retried = value.acquire(item, new AbortController().signal)
    await vi.runAllTimersAsync()
    const cover = await retried
    expect(cover.kind).toBe('spread')
    cover.release()
  })
})
