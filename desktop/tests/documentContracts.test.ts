import { describe, expect, it } from 'vitest'
import {
  documentChangeEventSchema,
  documentSummarySchema,
  mutateReaderAnnotationsRequestSchema,
  readerAnnotationSnapshotSchema
} from '@shared/ipcSchemas'

const documentId = '11111111-1111-4111-8111-111111111111'
const artifactId = '22222222-2222-4222-8222-222222222222'

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: documentId,
    originalName: 'paper.pdf',
    displayName: 'paper.pdf',
    sourceHash: 'source-hash',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    workflow: { status: 'parsing', progress: 10, activeJobKind: 'parse', error: null },
    processing: { parserModel: 'vlm', translationProvider: 'qwen' },
    ...overrides
  }
}

function annotation(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    documentId,
    artifactId,
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
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('v2 document IPC schemas', () => {
  it('uses strict UUID, NUL, length, and array bounds', () => {
    expect(documentSummarySchema.parse(summary()).id).toBe(documentId)
    expect(() => documentSummarySchema.parse(summary({ extra: true }))).toThrow()
    expect(() => documentSummarySchema.parse(summary({ id: 'document-1' }))).toThrow()
    expect(() => documentSummarySchema.parse(summary({ originalName: 'bad\0.pdf' }))).toThrow()
    expect(() => documentSummarySchema.parse(summary({ workflow: { status: 'parsing', progress: 101, activeJobKind: 'parse', error: null } }))).toThrow()

    const tooMany = Array.from({ length: 1_001 }, (_, index) => ({ ...summary(), id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}` }))
    expect(() => documentChangeEventSchema.parse({ revision: 1, upserted: tooMany, removedIds: [] })).toThrow()
  })

  it('requires annotation identity to match its mutation envelope', () => {
    const valid = {
      documentId,
      artifactId,
      view: 'original' as const,
      expectedRevision: 0,
      upserts: [annotation()],
      deleteIds: []
    }
    expect(mutateReaderAnnotationsRequestSchema.parse(valid)).toEqual(valid)
    expect(() => mutateReaderAnnotationsRequestSchema.parse({
      ...valid,
      upserts: [annotation({ documentId: '44444444-4444-4444-8444-444444444444' })]
    })).toThrow()
    expect(() => mutateReaderAnnotationsRequestSchema.parse({
      ...valid,
      upserts: [annotation()],
      deleteIds: [annotation().id]
    })).toThrow()
    expect(() => mutateReaderAnnotationsRequestSchema.parse({
      ...valid,
      upserts: [annotation({ quote: 'a\0pha' })]
    })).toThrow()
  })

  it('keeps the reader snapshot shape path-free and strict', () => {
    const value = {
      documentId,
      artifactId,
      view: 'original' as const,
      revision: 1,
      annotations: [annotation()]
    }
    expect(readerAnnotationSnapshotSchema.parse(value)).toEqual(value)
    expect(() => readerAnnotationSnapshotSchema.parse({ ...value, outputDir: 'C:/secret' })).toThrow()
  })
})
