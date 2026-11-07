import { describe, expect, it, vi } from 'vitest'
import { DocumentFeed } from '../../../src/features/library/main/documentFeed'
import { documentEventDisposition, getDocumentRefreshPlan } from '../../../src/features/library/renderer/documentCache'
import type { DocumentSummary, DocumentChangeEvent } from '@features/library/contract/documentSchemas'
const summary: DocumentSummary = { id: '11111111-1111-4111-8111-111111111111', originalName: 'paper.pdf', displayName: 'paper', sourceHash: 'source', workflow: { status: 'parsing', progress: 20, activeJobKind: 'parse', error: null }, processing: { translationProvider: 'qwen' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
describe('incremental document feed', () => {
  it('shares startup loading with concurrent snapshots and retains queued progress', async () => {
    let complete!: (value: DocumentSummary[]) => void
    const repository = { listDocumentSummaries: vi.fn(() => new Promise<DocumentSummary[]>(resolve => { complete = resolve })), getDocumentSummary: vi.fn(async () => ({ ...summary, workflow: { ...summary.workflow, progress: 40 } })) }
    const events: DocumentChangeEvent[] = []
    const feed = new DocumentFeed(repository, event => events.push(event), () => { throw new Error('refresh failed') })
    const loading = feed.load(), first = feed.snapshot(), second = feed.snapshot()
    feed.refresh({ documentId: summary.id, kind: 'progress' })
    await Promise.resolve()
    complete([summary])
    await loading
    expect((await first).sessionId).toBe((await second).sessionId)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(repository.listDocumentSummaries).toHaveBeenCalledTimes(1)
    expect((await feed.snapshot()).documents[0]!.workflow.progress).toBe(40)
  })
  it('queries one document for progress without scanning the library or invalidating content', async () => {
    const repository = { listDocumentSummaries: vi.fn(async () => [summary]), getDocumentSummary: vi.fn(async () => ({ ...summary, workflow: { ...summary.workflow, progress: 21 } })) }
    const events: DocumentChangeEvent[] = []
    const feed = new DocumentFeed(repository, event => events.push(event), () => { throw new Error('refresh failed') })
    const initial = await feed.snapshot()
    feed.refresh({ documentId: summary.id, kind: 'progress' })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(repository.listDocumentSummaries).toHaveBeenCalledTimes(1)
    expect(repository.getDocumentSummary).toHaveBeenCalledExactlyOnceWith(summary.id)
    expect(events[0]!.sessionId).toBe(initial.sessionId)
    expect(getDocumentRefreshPlan(summary, events[0]!.upserted[0]!, ['progress']).invalidateDocument).toBe(false)
    expect((await feed.snapshot()).revision).toBe(1)
    expect(documentEventDisposition(initial, events[0]!)).toBe('apply')
    expect(documentEventDisposition(await feed.snapshot(), events[0]!)).toBe('ignore')
    expect(documentEventDisposition(initial, { ...events[0]!, revision: 3 })).toBe('resync')
    await feed.load()
    expect(documentEventDisposition(await feed.snapshot(), events[0]!)).toBe('resync')
  })
  it('emits deletion and edit versions even when summary metadata did not change', async () => {
    let row: DocumentSummary | null = summary
    const events: DocumentChangeEvent[] = []
    const feed = new DocumentFeed({ listDocumentSummaries: async () => [summary], getDocumentSummary: async () => row }, event => events.push(event), () => undefined)
    await feed.load()
    feed.refresh({ documentId: summary.id, kind: 'edit', version: '4' })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.changes![0]!.versions).toEqual({ edit: '4' })
    row = null
    feed.refresh({ documentId: summary.id, kind: 'delete' })
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[1]!.removedIds).toEqual([summary.id])
    expect((await feed.snapshot()).documents).toEqual([])
  })
})
