import { describe, expect, it } from 'vitest'
import type { DocumentAnnotation } from '@shared/ipcSchemas'
import { buildAnnotationDiff, replayAnnotationDiff } from '../src/renderer/annotationMutations'

const base: DocumentAnnotation = {
  id: '33333333-3333-4333-8333-333333333333',
  documentId: '11111111-1111-4111-8111-111111111111',
  artifactId: '22222222-2222-4222-8222-222222222222',
  view: 'original',
  kind: 'highlight',
  color: 'yellow',
  blockKey: 'content:0',
  startOffset: 0,
  endOffset: 5,
  quote: 'alpha',
  prefix: '',
  suffix: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}
const created: DocumentAnnotation = { ...base, id: '44444444-4444-4444-8444-444444444444', startOffset: 6, endOffset: 10, quote: 'beta' }

describe('annotation mutation/replay helpers', () => {
  it('sends only changed upserts and deletes', () => {
    const diff = buildAnnotationDiff([base], [{ ...base, quote: 'ALPHA' }, created])
    expect(diff.upserts.map((annotation) => annotation.id)).toEqual([base.id, created.id])
    expect(diff.deleteIds).toEqual([])
    expect(buildAnnotationDiff([base, created], [base])).toEqual({ upserts: [], deleteIds: [created.id] })
  })

  it('replays local changes once while server wins concurrent edits and deletes', () => {
    const local = { ...base, quote: 'ALPHA' }
    const diff = buildAnnotationDiff([base], [local])
    const concurrentEdit = { ...base, quote: 'SERVER' }
    expect(replayAnnotationDiff([base], [concurrentEdit], diff)).toEqual({ upserts: [], deleteIds: [] })
    expect(replayAnnotationDiff([base], [], diff)).toEqual({ upserts: [], deleteIds: [] })
    expect(replayAnnotationDiff([base], [base], diff)).toEqual(diff)
  })

  it('does not recreate a row deleted concurrently, but replays a genuinely new row', () => {
    const localEdit = { ...base, quote: 'ALPHA' }
    const existingRowDiff = buildAnnotationDiff([base], [localEdit])
    expect(replayAnnotationDiff([base], [], existingRowDiff)).toEqual({ upserts: [], deleteIds: [] })

    const newRowDiff = buildAnnotationDiff([], [created])
    expect(replayAnnotationDiff([], [], newRowDiff)).toEqual(newRowDiff)
    expect(replayAnnotationDiff([], [created], newRowDiff)).toEqual({ upserts: [], deleteIds: [] })
  })
})
