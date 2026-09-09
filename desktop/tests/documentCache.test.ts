import { describe, expect, it } from 'vitest'
import type { DocumentChangeEvent, DocumentSummary } from '@shared/ipcSchemas'
import {
  applyDocumentChange,
  getDocumentRefreshPlan,
  patchDocumentDetails,
  type DocumentListCache
} from '../src/renderer/documentCache'

const first: DocumentSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  originalName: 'first.pdf',
  displayName: 'first.pdf',
  sourceHash: 'first-hash',
  workflow: { status: 'completed', progress: 100, activeJobKind: null, error: null },
  processing: { translationProvider: 'qwen' },
  createdAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z'
}
const second: DocumentSummary = {
  ...first,
  id: '22222222-2222-4222-8222-222222222222',
  originalName: 'second.pdf',
  displayName: 'second.pdf',
  createdAt: '2026-01-01T00:00:00.000Z'
}
const newlyImported: DocumentSummary = {
  ...first,
  id: '33333333-3333-4333-8333-333333333333',
  originalName: 'new.pdf',
  displayName: 'new.pdf',
  createdAt: '2026-01-03T00:00:00.000Z',
  updatedAt: '2026-01-03T00:00:00.000Z'
}

const change: DocumentChangeEvent = {
  revision: 4,
  upserted: [{ ...second, workflow: { ...second.workflow, status: 'parsing', progress: 12, activeJobKind: 'parse' } }],
  removedIds: [first.id]
}

describe('renderer document cache patching', () => {
  it('patches rows and keeps created_at DESC order', () => {
    const current: DocumentListCache = { revision: 3, documents: [second, first] }
    const next = applyDocumentChange(current, change)
    expect(next.revision).toBe(4)
    expect(next.documents.map((document) => document.id)).toEqual([second.id])
    expect(next.documents[0]?.workflow.progress).toBe(12)
  })

  it('inserts a new document into created_at DESC order instead of appending', () => {
    const current: DocumentListCache = { revision: 3, documents: [first, second] }
    const next = applyDocumentChange(current, {
      revision: 4,
      upserted: [newlyImported],
      removedIds: []
    })
    expect(next.documents.map((document) => document.id)).toEqual([
      newlyImported.id,
      first.id,
      second.id
    ])
  })

  it('ignores duplicate or stale events and patches loaded details only', () => {
    const current: DocumentListCache = { revision: 4, documents: [first] }
    expect(applyDocumentChange(current, change)).toBe(current)
    const detail = {
      summary: first,
      markdown: '# first',
      translatedMarkdown: '',
      translatedBlocks: null,
      layoutJson: '{}',
      mappings: [],
      pdfUrl: 'copilotix-asset://first/original.pdf',
      assetBaseUrl: 'copilotix-asset://first/'
    }
    expect(patchDocumentDetails(detail, change)).toBeUndefined()
  })

  it('invalidates content only on workflow transitions, not progress-only events', () => {
    const parsing = {
      ...first,
      workflow: { status: 'parsing' as const, progress: 10, activeJobKind: 'parse' as const, error: null }
    }
    const parsingProgress = { ...parsing, workflow: { ...parsing.workflow, progress: 11 } }
    const translating = {
      ...parsing,
      workflow: { status: 'translating' as const, progress: 45, activeJobKind: 'translate' as const, error: null }
    }
    const completed = {
      ...translating,
      workflow: { status: 'completed' as const, progress: 100, activeJobKind: null, error: null }
    }
    expect(getDocumentRefreshPlan(parsing, parsingProgress)).toEqual({ invalidateDocument: false, annotationViews: [] })
    expect(getDocumentRefreshPlan(parsing, translating)).toEqual({ invalidateDocument: true, annotationViews: ['original'] })
    expect(getDocumentRefreshPlan(translating, completed)).toEqual({
      invalidateDocument: true,
      annotationViews: ['original', 'translated']
    })
    expect(getDocumentRefreshPlan(completed, { ...completed, updatedAt: '2026-01-04T00:00:00.000Z' })).toEqual({
      invalidateDocument: false,
      annotationViews: []
    })
  })
})
