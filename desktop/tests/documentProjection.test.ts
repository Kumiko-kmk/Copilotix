import { describe, expect, it } from 'vitest'
import { computeDocumentChange } from '@main/documentProjection'
import { documentSummarySchema, type DocumentSummary } from '@shared/ipcSchemas'

const first: DocumentSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  originalName: 'first.pdf',
  displayName: 'first.pdf',
  sourceHash: 'hash-first',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  workflow: { status: 'parsing', progress: 10, activeJobKind: 'parse', error: null },
  processing: { parserModel: 'vlm', translationProvider: 'qwen' }
}
const second: DocumentSummary = {
  ...first,
  id: '22222222-2222-4222-8222-222222222222',
  originalName: 'second.pdf'
}

describe('document list change projection', () => {
  it('does not advance the revision for a no-op', () => {
    const result = computeDocumentChange(new Map([[first.id, first]]), [first], 7)
    expect(result.event).toBeNull()
    expect(result.next).toEqual(new Map([[first.id, first]]))
  })

  it('emits ordered upserts and removals with a monotonic revision', () => {
    const changed = { ...first, workflow: { ...first.workflow, progress: 25 } }
    const result = computeDocumentChange(new Map([[first.id, first], [second.id, second]]), [changed], 7)
    expect(result.event).toEqual({ revision: 8, upserted: [changed], removedIds: [second.id] })
    expect(result.next).toEqual(new Map([[first.id, changed]]))
  })

  it('rejects duplicate IDs instead of broadcasting an ambiguous diff', () => {
    expect(() => computeDocumentChange(new Map(), [first, first], 0)).toThrow()
  })

  it('models terminal and queued workflow states without leaking processing details', () => {
    expect(first.workflow.activeJobKind).toBe('parse')
    expect({ ...first, workflow: { ...first.workflow, status: 'completed', activeJobKind: null } }.workflow.activeJobKind).toBeNull()
    expect({ ...first, workflow: { ...first.workflow, status: 'queued' } }.workflow.status).toBe('queued')
    expect(Object.keys(documentSummarySchema.parse(first))).toEqual(['id', 'originalName', 'displayName', 'sourceHash', 'workflow', 'processing', 'createdAt', 'updatedAt'])
  })
})
