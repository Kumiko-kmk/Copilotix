import { describe, expect, it } from 'vitest'
import type { JobKind } from '@platform/jobs/core/jobs'
import {
  RAG_MAX_RESULT_PAGE_ITEMS,
  RAG_MAX_SERIALIZED_BYTES,
  RAG_MAX_STREAM_DELTA_CHARS,
  RAG_MAX_STREAM_EVENTS,
  RAG_MAX_TOTAL_RESULTS,
  RAG_STREAM_EVENT_TRANSITIONS,
  canTransitionRagStreamEvent,
  citationLocatorSchema,
  citationSchema,
  isWithinRagWireLimit,
  localIndexStateSchema,
  ragErrorCodeSchema,
  ragErrorSchema,
  ragStreamEventSchema,
  ragWireByteLength,
  selectionFragmentSchema,
  semanticIndexStateSchema
} from '@features/chat/contract/ragSchemas'
import {
  documentSummarySchema,
  documentWorkflowSchema,
  documentWorkflowStatusSchema
} from '@shared/ipcSchemas'
import type { DocumentWorkflowStatus } from '@shared/ipcSchemas'

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`

const documentId = uuid(1)
const contentRevisionId = uuid(3)
const artifactId = uuid(4)
const citationId = uuid(6)
const requestId = uuid(7)
const contentHash = 'a'.repeat(64)

const ragError = {
  code: 'PROVIDER_UNAVAILABLE' as const,
  message: 'The embedding provider is unavailable',
  retryable: true,
  retryAfterMs: 1_000,
  traceId: 'trace-1'
}

function locator(overrides: Record<string, unknown> = {}) {
  return {
    documentId,
    artifactId,
    contentRevisionId,
    contentHash,
    mappingIds: ['content:0'],
    pageStart: 1,
    pageEnd: 1,
    sourceStartOffset: 0,
    sourceEndOffset: 12,
    offsetUnit: 'utf16',
    ...overrides
  }
}

function citation(overrides: Record<string, unknown> = {}) {
  return {
    citationId,
    documentId,
    chunkId: 'chunk-1',
    excerpt: 'A cited excerpt from the indexed document.',
    locator: locator(),
    scoreProvenance: [{ source: 'lexical', rank: 1, score: 0.5, algorithm: 'bm25' }],
    ...overrides
  }
}

function withoutField(value: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...value }
  delete copy[field]
  return copy
}

type Expect<T extends true> = T
type Equal<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends
  <T>() => T extends Right ? 1 : 2 ? true : false
type JobKindContractIncludesRagKinds = Expect<Equal<JobKind, 'parse' | 'translate' | 'rag-content-index' | 'rag-embed' | 'rag-delete'>>
type DocumentWorkflowContractIsUnchanged = Expect<Equal<
  DocumentWorkflowStatus,
  'queued' | 'uploading' | 'parsing' | 'translating' | 'partial' | 'completed' | 'failed'
>>
const jobKindContractIncludesRagKinds: JobKindContractIncludesRagKinds = true
const documentWorkflowContractIsUnchanged: DocumentWorkflowContractIsUnchanged = true

describe('chat index state contracts', () => {
  it('exposes the persisted state enums and rejects unknown states', () => {
    expect(localIndexStateSchema.options).toEqual(['unindexed', 'queued', 'indexing', 'ready', 'stale', 'failed'])
    expect(semanticIndexStateSchema.options).toEqual([
      'disabled', 'requires-consent', 'requires-credential', 'queued', 'indexing', 'ready', 'stale', 'failed'
    ])
    expect(() => localIndexStateSchema.parse('unknown')).toThrow()
    expect(() => semanticIndexStateSchema.parse('unknown')).toThrow()
  })
})

describe('chat wire safety and identity snapshots', () => {
  it('enforces a UTF-8 serialized 1 MiB boundary exactly', () => {
    const overhead = ragWireByteLength({ payload: '' })
    const atLimit = { payload: 'x'.repeat(RAG_MAX_SERIALIZED_BYTES - overhead) }
    const overLimit = { payload: `${atLimit.payload}x` }

    expect(ragWireByteLength(atLimit)).toBe(RAG_MAX_SERIALIZED_BYTES)
    expect(isWithinRagWireLimit(atLimit)).toBe(true)
    expect(isWithinRagWireLimit(overLimit)).toBe(false)
  })

  it('requires artifact, content revision, and content hash on citations', () => {
    const baseLocator = locator()
    expect(citationLocatorSchema.parse(baseLocator)).toEqual(baseLocator)
    for (const field of ['artifactId', 'contentRevisionId', 'contentHash']) {
      const missingLocator = withoutField(baseLocator, field)
      expect(() => citationLocatorSchema.parse(missingLocator), `missing locator ${field}`).toThrow()
      expect(() => citationSchema.parse(citation({ locator: missingLocator })), `missing citation ${field}`).toThrow()
    }
    expect(() => citationLocatorSchema.parse(locator({ contentHash: 'not-a-sha256' }))).toThrow()
  })

  it('rejects unknown fields on every chat DTO shape', () => {
    const samples: ReadonlyArray<readonly [string, { parse: (value: unknown) => unknown }, Record<string, unknown>]> = [
      ['error', ragErrorSchema, ragError],
      ['citation', citationSchema, citation()],
      ['fragment', selectionFragmentSchema, { mappingIds: ['content:0'], startOffset: 0, endOffset: 12, quote: 'Selected text' }],
      ['stream', ragStreamEventSchema, { requestId, sequence: 0, type: 'accepted' }]
    ]
    for (const [name, schema, value] of samples) {
      expect(() => schema.parse({ ...value, unexpected: true }), name).toThrow()
    }
  })
})

describe('chat bounded answer stream and stable errors', () => {
  it('accepts the bounded event shapes and enforces event order', () => {
    const events = [
      { requestId, sequence: 0, type: 'accepted' as const },
      { requestId, sequence: 1, type: 'retrieving' as const, progress: 20 },
      { requestId, sequence: 2, type: 'evidence-ready' as const, resultCount: 1 },
      { requestId, sequence: 3, type: 'delta' as const, delta: 'Answer' },
      { requestId, sequence: 4, type: 'citation' as const, citation: citation() },
      { requestId, sequence: 5, type: 'delta' as const, delta: ' with evidence.' },
      { requestId, sequence: 6, type: 'completed' as const, answer: 'Answer with evidence.', citationIds: [citationId] },
      { requestId, sequence: 7, type: 'failed' as const, error: ragError },
      { requestId, sequence: 8, type: 'cancelled' as const, reason: 'cancelled by user' }
    ]
    for (const event of events) expect(ragStreamEventSchema.parse(event)).toEqual(event)

    const order: Array<Parameters<typeof canTransitionRagStreamEvent>[1]> = [
      'accepted',
      'retrieving',
      'evidence-ready',
      'delta',
      'citation',
      'completed'
    ]
    for (let index = 0; index < order.length - 1; index += 1) {
      const from = order[index]
      const to = order[index + 1]
      if (from === undefined || to === undefined) throw new Error('stream order fixture is incomplete')
      expect(canTransitionRagStreamEvent(from, to)).toBe(true)
    }
    expect(canTransitionRagStreamEvent(null, 'accepted')).toBe(true)
    expect(canTransitionRagStreamEvent(null, 'retrieving')).toBe(false)
    expect(canTransitionRagStreamEvent('accepted', 'delta')).toBe(false)
    expect(canTransitionRagStreamEvent('completed', 'delta')).toBe(false)
    expect(canTransitionRagStreamEvent('failed', 'accepted')).toBe(false)
    expect(canTransitionRagStreamEvent('retrieving', 'retrieving')).toBe(true)
    expect(canTransitionRagStreamEvent('delta', 'delta')).toBe(true)
    expect(canTransitionRagStreamEvent('citation', 'citation')).toBe(true)
    expect(RAG_STREAM_EVENT_TRANSITIONS.completed).toEqual([])
  })

  it('enforces sequence, delta, evidence, answer, and citation-id bounds', () => {
    const accepted = { requestId, sequence: RAG_MAX_STREAM_EVENTS, type: 'accepted' as const }
    expect(ragStreamEventSchema.parse(accepted)).toEqual(accepted)
    expect(() => ragStreamEventSchema.parse({ ...accepted, sequence: RAG_MAX_STREAM_EVENTS + 1 })).toThrow()

    const delta = { requestId, sequence: 1, type: 'delta' as const, delta: 'd'.repeat(RAG_MAX_STREAM_DELTA_CHARS) }
    expect(ragStreamEventSchema.parse(delta)).toEqual(delta)
    expect(() => ragStreamEventSchema.parse({ ...delta, delta: `${delta.delta}d` })).toThrow()
    expect(() => ragStreamEventSchema.parse({ ...delta, delta: '' })).toThrow()

    const evidence = { requestId, sequence: 1, type: 'evidence-ready' as const, resultCount: RAG_MAX_RESULT_PAGE_ITEMS }
    expect(ragStreamEventSchema.parse(evidence)).toEqual(evidence)
    expect(() => ragStreamEventSchema.parse({ ...evidence, resultCount: RAG_MAX_TOTAL_RESULTS + 1 })).toThrow()

    const completed = {
      requestId,
      sequence: 1,
      type: 'completed' as const,
      answer: 'a'.repeat(32_768),
      citationIds: Array.from({ length: RAG_MAX_RESULT_PAGE_ITEMS }, (_, index) => uuid(index + 20))
    }
    expect(ragStreamEventSchema.parse(completed)).toEqual(completed)
    expect(() => ragStreamEventSchema.parse({ ...completed, answer: `${completed.answer}a` })).toThrow()
    expect(() => ragStreamEventSchema.parse({
      ...completed,
      citationIds: [...completed.citationIds, uuid(100)]
    })).toThrow()
  })

  it('accepts every stable error code and rejects unknown or unbounded errors', () => {
    expect(ragErrorCodeSchema.options).toHaveLength(26)
    expect(ragErrorCodeSchema.options).toContain('CHAT_STORAGE_FAILED')
    expect(ragErrorCodeSchema.options).toContain('FIGURE_UNAVAILABLE')
    for (const code of ragErrorCodeSchema.options) {
      expect(ragErrorCodeSchema.parse(code)).toBe(code)
      expect(ragErrorSchema.parse({ ...ragError, code })).toMatchObject({ code })
    }
    expect(() => ragErrorCodeSchema.parse('UNKNOWN_RAG_ERROR')).toThrow()
    expect(() => ragErrorSchema.parse({ ...ragError, message: '' })).toThrow()
    expect(() => ragErrorSchema.parse({ ...ragError, message: 'e'.repeat(1_025) })).toThrow()
    expect(() => ragErrorSchema.parse({ ...ragError, retryAfterMs: -1 })).toThrow()
    expect(() => ragErrorSchema.parse({ ...ragError, retryAfterMs: 86_400_001 })).toThrow()
  })
})

describe('existing document and job contracts', () => {
  it('extends JobKind without changing document workflow statuses', () => {
    const jobKinds = ['parse', 'translate', 'rag-content-index', 'rag-embed', 'rag-delete'] as const satisfies readonly JobKind[]
    expect(jobKinds).toEqual(['parse', 'translate', 'rag-content-index', 'rag-embed', 'rag-delete'])
    expect(jobKindContractIncludesRagKinds).toBe(true)
    expect(documentWorkflowContractIsUnchanged).toBe(true)

    expect(documentWorkflowStatusSchema.options).toEqual([
      'queued',
      'uploading',
      'parsing',
      'translating',
      'partial',
      'completed',
      'failed'
    ])
    for (const status of documentWorkflowStatusSchema.options) {
      expect(documentWorkflowStatusSchema.parse(status)).toBe(status)
    }
    expect(() => documentWorkflowStatusSchema.parse('indexing')).toThrow()
    expect(() => documentWorkflowStatusSchema.parse('chat-ready')).toThrow()
  })

  it('does not admit RAG states into the document workflow DTO', () => {
    const workflow = { status: 'parsing' as const, progress: 10, activeJobKind: 'parse' as const, error: null }
    expect(documentWorkflowSchema.parse(workflow)).toEqual(workflow)
    expect(() => documentWorkflowSchema.parse({ ...workflow, status: 'indexing' })).toThrow()
    expect(() => documentWorkflowSchema.parse({ ...workflow, indexState: 'ready' })).toThrow()
    expect(() => documentWorkflowSchema.parse({ ...workflow, chat: 'ready' })).toThrow()

    const summary = {
      id: documentId,
      originalName: 'paper.pdf',
      displayName: 'paper.pdf',
      sourceHash: 'source-hash',
      workflow,
      processing: { translationProvider: 'qwen' as const },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    expect(documentSummarySchema.parse(summary)).toEqual(summary)
    expect(() => documentSummarySchema.parse({ ...summary, indexing: 'ready' })).toThrow()
  })
})

describe('paper chat citation compatibility', () => {
  it('accepts honest selection and full-text provenance and deterministic revision IDs', () => {
    for (const source of ['selection', 'full-text'] as const) {
      const parsed = citationSchema.parse({ ...citation(), locator: { ...citation().locator, contentRevisionId: 'rag-content-revision-' + 'a'.repeat(64) }, scoreProvenance: [{ source, rank: 1, score: 1 }] })
      expect(parsed.scoreProvenance[0]!.source).toBe(source)
    }
  })
})
