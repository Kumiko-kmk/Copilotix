import { describe, expect, it } from 'vitest'
import type { JobKind } from '@core/types'
import {
  CHAT_AVAILABILITY_TRANSITIONS,
  LOCAL_INDEX_STATE_TRANSITIONS,
  MAX_RAG_WIRE_BYTES,
  RAG_ERROR_CODES,
  RAG_MAX_CURSOR_CHARS,
  RAG_MAX_QUERY_CHARS,
  RAG_MAX_RESULT_PAGE_ITEMS,
  RAG_MAX_SCOPE_DOCUMENT_IDS,
  RAG_MAX_SERIALIZED_BYTES,
  RAG_MAX_STREAM_DELTA_CHARS,
  RAG_MAX_STREAM_EVENTS,
  RAG_MAX_TOTAL_RESULTS,
  RAG_STREAM_EVENT_TRANSITIONS,
  SEMANTIC_INDEX_STATE_TRANSITIONS,
  assertRagWireSize,
  canTransitionChatAvailability,
  canTransitionLocalIndexState,
  canTransitionRagStreamEvent,
  canTransitionSemanticIndexState,
  chatAvailabilitySchema,
  citationLocatorSchema,
  citationSchema,
  denseSearchRequestSchema,
  hybridSearchRequestSchema,
  isWithinRagWireLimit,
  knowledgeStatusSchema,
  lexicalSearchRequestSchema,
  lexicalSearchResultSchema,
  localIndexStateSchema,
  localIndexStatusSchema,
  ragErrorCodeSchema,
  ragErrorSchema,
  ragQuerySchema,
  ragScopeSchema,
  ragSearchRequestSchema,
  ragSearchResultPageSchema,
  ragStreamEventSchema,
  ragWireByteLength,
  scoreProvenanceSchema,
  searchResultItemSchema,
  semanticIndexStateSchema,
  semanticIndexStatusSchema,
  selectionRequestSchema,
  selectionSnapshotSchema
} from '@shared/ragSchemas'
import {
  documentSummarySchema,
  documentWorkflowSchema,
  documentWorkflowStatusSchema
} from '@shared/ipcSchemas'
import type { DocumentWorkflowStatus } from '@shared/ipcSchemas'

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`

const documentId = uuid(1)
const anotherDocumentId = uuid(2)
const contentRevisionId = uuid(3)
const artifactId = uuid(4)
const vectorIndexId = uuid(5)
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

function localReady(overrides: Record<string, unknown> = {}) {
  return {
    state: 'ready',
    progress: 100,
    activeContentRevisionId: contentRevisionId,
    error: null,
    ...overrides
  }
}

function semanticReady(overrides: Record<string, unknown> = {}) {
  return {
    state: 'ready',
    progress: 100,
    activeContentRevisionId: contentRevisionId,
    activeVectorIndexId: vectorIndexId,
    profileId: 'embedding-default',
    error: null,
    ...overrides
  }
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

function resultItem(number = 1, overrides: Record<string, unknown> = {}) {
  return {
    resultId: `result-${number}`,
    documentId,
    contentRevisionId,
    chunkId: `chunk-${number}`,
    excerpt: 'A bounded excerpt from the indexed document.',
    sectionPath: ['Introduction'],
    contentType: 'paragraph',
    locator: locator(),
    scoreProvenance: [{ source: 'lexical', rank: number, score: 0.5, algorithm: 'bm25' }],
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

function selectionRequest(overrides: Record<string, unknown> = {}) {
  return {
    documentId,
    scope: { kind: 'current-document', documentId },
    view: 'original',
    text: 'Selected text from the current document.',
    fragments: [{ mappingIds: ['content:0'], startOffset: 0, endOffset: 12, quote: 'Selected text' }],
    snapshot: { artifactId, contentRevisionId, contentHash },
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

describe('RAG state contracts', () => {
  it('exposes the independent state enums and rejects unknown states', () => {
    expect(localIndexStateSchema.options).toEqual([
      'unindexed',
      'queued',
      'indexing',
      'ready',
      'stale',
      'failed'
    ])
    expect(semanticIndexStateSchema.options).toEqual([
      'disabled',
      'requires-consent',
      'requires-credential',
      'queued',
      'indexing',
      'ready',
      'stale',
      'failed'
    ])
    expect(chatAvailabilitySchema.options).toEqual(['disabled', 'requires-credential', 'ready'])

    for (const state of localIndexStateSchema.options) expect(localIndexStateSchema.parse(state)).toBe(state)
    for (const state of semanticIndexStateSchema.options) expect(semanticIndexStateSchema.parse(state)).toBe(state)
    for (const state of chatAvailabilitySchema.options) expect(chatAvailabilitySchema.parse(state)).toBe(state)
    expect(() => localIndexStateSchema.parse('unknown')).toThrow()
    expect(() => semanticIndexStateSchema.parse('unknown')).toThrow()
    expect(() => chatAvailabilitySchema.parse('unknown')).toThrow()
  })

  it('allows only the documented local, semantic, and chat transitions', () => {
    const localLegal: ReadonlyArray<readonly [Parameters<typeof canTransitionLocalIndexState>[0] & string, Parameters<typeof canTransitionLocalIndexState>[1]]> = [
      ['unindexed', 'queued'],
      ['unindexed', 'failed'],
      ['queued', 'indexing'],
      ['queued', 'failed'],
      ['indexing', 'queued'],
      ['indexing', 'ready'],
      ['indexing', 'failed'],
      ['ready', 'stale'],
      ['stale', 'queued'],
      ['stale', 'indexing'],
      ['stale', 'failed'],
      ['failed', 'queued']
    ]
    for (const [from, to] of localLegal) expect(canTransitionLocalIndexState(from, to)).toBe(true)
    expect(canTransitionLocalIndexState(null, 'unindexed')).toBe(true)
    expect(canTransitionLocalIndexState(null, 'queued')).toBe(false)
    expect(canTransitionLocalIndexState('unindexed', 'ready')).toBe(false)
    expect(canTransitionLocalIndexState('queued', 'ready')).toBe(false)
    expect(canTransitionLocalIndexState('ready', 'indexing')).toBe(false)
    expect(canTransitionLocalIndexState('failed', 'ready')).toBe(false)
    for (const state of Object.keys(LOCAL_INDEX_STATE_TRANSITIONS) as Array<Parameters<typeof canTransitionLocalIndexState>[0] & string>) {
      expect(canTransitionLocalIndexState(state, state)).toBe(true)
    }

    const semanticLegal: ReadonlyArray<readonly [Parameters<typeof canTransitionSemanticIndexState>[0] & string, Parameters<typeof canTransitionSemanticIndexState>[1]]> = [
      ['disabled', 'requires-consent'],
      ['requires-consent', 'disabled'],
      ['requires-consent', 'requires-credential'],
      ['requires-credential', 'disabled'],
      ['requires-credential', 'requires-consent'],
      ['requires-credential', 'queued'],
      ['queued', 'disabled'],
      ['queued', 'requires-consent'],
      ['queued', 'requires-credential'],
      ['queued', 'indexing'],
      ['queued', 'failed'],
      ['indexing', 'queued'],
      ['indexing', 'ready'],
      ['indexing', 'failed'],
      ['ready', 'stale'],
      ['ready', 'disabled'],
      ['stale', 'queued'],
      ['stale', 'indexing'],
      ['stale', 'failed'],
      ['stale', 'disabled'],
      ['stale', 'requires-consent'],
      ['stale', 'requires-credential'],
      ['failed', 'queued'],
      ['failed', 'disabled'],
      ['failed', 'requires-consent'],
      ['failed', 'requires-credential']
    ]
    for (const [from, to] of semanticLegal) expect(canTransitionSemanticIndexState(from, to)).toBe(true)
    expect(canTransitionSemanticIndexState(null, 'disabled')).toBe(true)
    expect(canTransitionSemanticIndexState(null, 'ready')).toBe(false)
    expect(canTransitionSemanticIndexState('disabled', 'ready')).toBe(false)
    expect(canTransitionSemanticIndexState('requires-consent', 'ready')).toBe(false)
    expect(canTransitionSemanticIndexState('indexing', 'requires-consent')).toBe(false)
    expect(canTransitionSemanticIndexState('failed', 'ready')).toBe(false)
    for (const state of Object.keys(SEMANTIC_INDEX_STATE_TRANSITIONS) as Array<Parameters<typeof canTransitionSemanticIndexState>[0] & string>) {
      expect(canTransitionSemanticIndexState(state, state)).toBe(true)
    }

    expect(canTransitionChatAvailability('disabled', 'requires-credential')).toBe(true)
    expect(canTransitionChatAvailability('requires-credential', 'disabled')).toBe(true)
    expect(canTransitionChatAvailability('requires-credential', 'ready')).toBe(true)
    expect(canTransitionChatAvailability('ready', 'disabled')).toBe(true)
    expect(canTransitionChatAvailability('ready', 'requires-credential')).toBe(true)
    expect(canTransitionChatAvailability(null, 'disabled')).toBe(true)
    expect(canTransitionChatAvailability(null, 'ready')).toBe(false)
    expect(canTransitionChatAvailability('disabled', 'ready')).toBe(false)
    expect(canTransitionChatAvailability('ready', 'ready')).toBe(true)
    expect(CHAT_AVAILABILITY_TRANSITIONS.ready).toEqual(['disabled', 'requires-credential'])
  })

  it('represents local readiness independently from semantic consent, credentials, and failures', () => {
    const local = localReady()
    const noConsent = {
      state: 'requires-consent',
      progress: 0,
      activeContentRevisionId: null,
      activeVectorIndexId: null,
      profileId: null,
      error: null
    }
    const withSavedKeyButNoConsent = { ...noConsent }
    const embeddingFailed = {
      state: 'failed',
      progress: 35,
      activeContentRevisionId: null,
      activeVectorIndexId: null,
      profileId: null,
      error: ragError
    }

    expect(knowledgeStatusSchema.parse({ local, semantic: noConsent, chat: 'disabled' })).toMatchObject({
      local: { state: 'ready' },
      semantic: { state: 'requires-consent' }
    })
    // A saved provider key is not proof of consent; the independent semantic
    // state remains requires-consent and carries no active vector identity.
    expect(semanticIndexStatusSchema.parse(withSavedKeyButNoConsent)).toMatchObject({
      state: 'requires-consent',
      activeVectorIndexId: null,
      profileId: null
    })
    expect(knowledgeStatusSchema.parse({ local, semantic: embeddingFailed, chat: 'ready' })).toMatchObject({
      local: { state: 'ready' },
      semantic: { state: 'failed', error: { code: 'PROVIDER_UNAVAILABLE' } }
    })
  })

  it('enforces state-specific identities, progress, and error invariants', () => {
    expect(localIndexStatusSchema.parse(localReady())).toEqual(localReady())
    expect(() => localIndexStatusSchema.parse(localReady({ activeContentRevisionId: null }))).toThrow()
    expect(() => localIndexStatusSchema.parse(localReady({ progress: 99 }))).toThrow()
    expect(() => localIndexStatusSchema.parse({ state: 'unindexed', progress: 0, activeContentRevisionId: contentRevisionId, error: null })).toThrow()
    expect(() => localIndexStatusSchema.parse({ state: 'failed', progress: 10, activeContentRevisionId: null, error: null })).toThrow()
    expect(() => localIndexStatusSchema.parse({ state: 'queued', progress: 10, activeContentRevisionId: null, error: ragError })).toThrow()

    expect(semanticIndexStatusSchema.parse(semanticReady())).toEqual(semanticReady())
    expect(() => semanticIndexStatusSchema.parse(semanticReady({ activeVectorIndexId: null }))).toThrow()
    expect(() => semanticIndexStatusSchema.parse(semanticReady({ profileId: null }))).toThrow()
    expect(() => semanticIndexStatusSchema.parse(semanticReady({ progress: 99 }))).toThrow()
    expect(() => semanticIndexStatusSchema.parse({
      state: 'requires-credential',
      progress: 0,
      activeContentRevisionId: contentRevisionId,
      activeVectorIndexId: null,
      profileId: null,
      error: null
    })).toThrow()
    expect(() => semanticIndexStatusSchema.parse({
      state: 'failed',
      progress: 10,
      activeContentRevisionId: null,
      activeVectorIndexId: null,
      profileId: null,
      error: null
    })).toThrow()
    expect(() => knowledgeStatusSchema.parse({
      local: localReady(),
      semantic: semanticReady({ activeContentRevisionId: anotherDocumentId }),
      chat: 'disabled'
    })).toThrow()
  })
})

describe('RAG scope, query, and retrieval contracts', () => {
  it('accepts the three explicit scope branches', () => {
    const scopes = [
      { kind: 'current-document', documentId },
      { kind: 'documents', documentIds: [documentId, anotherDocumentId] },
      { kind: 'collection', collectionId: uuid(8) }
    ] as const

    for (const scope of scopes) expect(ragScopeSchema.parse(scope)).toEqual(scope)
  })

  it('rejects empty, oversized, duplicate, and malformed explicit ID scopes', () => {
    expect(() => ragScopeSchema.parse({ kind: 'documents', documentIds: [] })).toThrow()
    expect(() => ragScopeSchema.parse({
      kind: 'documents',
      documentIds: Array.from({ length: RAG_MAX_SCOPE_DOCUMENT_IDS + 1 }, (_, index) => uuid(index + 10))
    })).toThrow()
    expect(() => ragScopeSchema.parse({ kind: 'documents', documentIds: [documentId, documentId] })).toThrow()
    expect(() => ragScopeSchema.parse({ kind: 'documents', documentIds: ['not-a-uuid'] })).toThrow()
    expect(() => ragScopeSchema.parse({ kind: 'document-ids', documentIds: [documentId] })).toThrow()
    expect(() => ragScopeSchema.parse({ kind: 'current-document', documentId: 'C:\\papers\\paper.pdf' })).toThrow()
    expect(() => ragScopeSchema.parse({ kind: 'collection', collectionId: 'collection-1' })).toThrow()
  })

  it('bounds search queries and rejects blank queries', () => {
    expect(ragQuerySchema.parse('q'.repeat(RAG_MAX_QUERY_CHARS))).toHaveLength(RAG_MAX_QUERY_CHARS)
    expect(() => ragQuerySchema.parse('q'.repeat(RAG_MAX_QUERY_CHARS + 1))).toThrow()
    expect(() => ragQuerySchema.parse('   ')).toThrow()
    expect(() => ragQuerySchema.parse('\0')).toThrow()
  })

  it('covers lexical, dense, and hybrid request/result discriminators', () => {
    const common = {
      scope: { kind: 'current-document', documentId },
      query: 'retrieval augmented generation',
      limit: 10,
      cursor: null
    }
    const requests = [
      { kind: 'lexical', ...common },
      { kind: 'dense', ...common, profileId: 'embedding-default' },
      { kind: 'hybrid', ...common, profileId: 'embedding-default', allowSemanticDegradation: true }
    ] as const
    expect(lexicalSearchRequestSchema.parse(requests[0])).toEqual(requests[0])
    expect(denseSearchRequestSchema.parse(requests[1])).toEqual(requests[1])
    expect(hybridSearchRequestSchema.parse(requests[2])).toEqual(requests[2])
    for (const request of requests) expect(ragSearchRequestSchema.parse(request)).toEqual(request)

    const item = resultItem()
    for (const kind of ['lexical', 'dense', 'hybrid'] as const) {
      const page = { kind, items: [item], nextCursor: null, total: 1 }
      expect(ragSearchResultPageSchema.parse(page)).toEqual(page)
    }
    expect(scoreProvenanceSchema.parse({ source: 'dense', rank: 1, score: 0.2, algorithm: 'cosine' })).toEqual({
      source: 'dense', rank: 1, score: 0.2, algorithm: 'cosine'
    })
  })

  it('enforces page item, total, cursor, and request limit bounds', () => {
    const maxPage = {
      kind: 'lexical' as const,
      items: Array.from({ length: RAG_MAX_RESULT_PAGE_ITEMS }, (_, index) => resultItem(index + 1)),
      nextCursor: 'c'.repeat(RAG_MAX_CURSOR_CHARS),
      total: RAG_MAX_TOTAL_RESULTS
    }
    expect(lexicalSearchResultSchema.parse(maxPage).items).toHaveLength(RAG_MAX_RESULT_PAGE_ITEMS)
    expect(lexicalSearchResultSchema.parse(maxPage).total).toBe(RAG_MAX_TOTAL_RESULTS)
    expect(() => lexicalSearchResultSchema.parse({
      ...maxPage,
      items: [...maxPage.items, resultItem(RAG_MAX_RESULT_PAGE_ITEMS + 1)]
    })).toThrow()
    expect(() => lexicalSearchResultSchema.parse({ ...maxPage, total: RAG_MAX_TOTAL_RESULTS + 1 })).toThrow()
    expect(() => lexicalSearchResultSchema.parse({
      ...maxPage,
      nextCursor: 'c'.repeat(RAG_MAX_CURSOR_CHARS + 1)
    })).toThrow()

    const request = {
      kind: 'lexical' as const,
      scope: { kind: 'current-document' as const, documentId },
      query: 'query',
      limit: RAG_MAX_RESULT_PAGE_ITEMS,
      cursor: 'cursor'
    }
    expect(lexicalSearchRequestSchema.parse(request)).toEqual(request)
    expect(() => lexicalSearchRequestSchema.parse({ ...request, limit: RAG_MAX_RESULT_PAGE_ITEMS + 1 })).toThrow()
    expect(() => lexicalSearchRequestSchema.parse({
      ...request,
      cursor: 'c'.repeat(RAG_MAX_CURSOR_CHARS + 1)
    })).toThrow()
  })
})

describe('RAG wire safety and identity snapshots', () => {
  it('enforces a UTF-8 serialized 1 MiB boundary exactly', () => {
    expect(MAX_RAG_WIRE_BYTES).toBe(RAG_MAX_SERIALIZED_BYTES)
    const overhead = ragWireByteLength({ payload: '' })
    const atLimit = { payload: 'x'.repeat(RAG_MAX_SERIALIZED_BYTES - overhead) }
    const overLimit = { payload: `${atLimit.payload}x` }

    expect(ragWireByteLength(atLimit)).toBe(RAG_MAX_SERIALIZED_BYTES)
    expect(isWithinRagWireLimit(atLimit)).toBe(true)
    expect(isWithinRagWireLimit(overLimit)).toBe(false)
    expect(() => assertRagWireSize(atLimit)).not.toThrow()
    expect(() => assertRagWireSize(overLimit)).toThrow()
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

  it('requires a complete artifact/content-revision snapshot for selections', () => {
    const valid = selectionRequest()
    expect(selectionSnapshotSchema.parse(valid.snapshot)).toEqual(valid.snapshot)
    expect(selectionRequestSchema.parse(valid)).toEqual(valid)
    for (const field of ['artifactId', 'contentRevisionId', 'contentHash']) {
      const missingSnapshot = withoutField(valid.snapshot, field)
      expect(() => selectionRequestSchema.parse({ ...valid, snapshot: missingSnapshot }), `missing selection ${field}`).toThrow()
    }

    const flatSnapshot = {
      documentId,
      scope: { kind: 'current-document' as const, documentId },
      view: 'translated' as const,
      text: valid.text,
      fragments: valid.fragments,
      artifactId,
      contentRevisionId,
      contentHash
    }
    expect(() => selectionRequestSchema.parse(flatSnapshot)).toThrow()
  })

  it('rejects unknown fields, including paths, SQL, provider URLs, keys, and float vectors', () => {
    const validRequest = {
      kind: 'lexical' as const,
      scope: { kind: 'current-document' as const, documentId },
      query: 'query',
      limit: 10,
      cursor: null
    }
    const forbiddenFields: ReadonlyArray<readonly [string, unknown]> = [
      ['path', 'C:\\private\\paper.pdf'],
      ['sql', 'SELECT * FROM chunks'],
      ['providerUrl', 'https://api.provider.invalid/v1'],
      ['apiKey', 'sk-secret-key'],
      ['vector', [0.1, 0.2, 0.3]]
    ]
    for (const [field, value] of forbiddenFields) {
      expect(() => lexicalSearchRequestSchema.parse({ ...validRequest, [field]: value }), field).toThrow()
    }
    expect(() => searchResultItemSchema.parse({ ...resultItem(), vector: [0.1, 0.2] })).toThrow()
    expect(() => ragScopeSchema.parse({ kind: 'current-document', documentId, path: 'C:\\private' })).toThrow()
  })

  it('rejects unknown fields on every major RAG DTO shape', () => {
    const samples: ReadonlyArray<readonly [string, { parse: (value: unknown) => unknown }, Record<string, unknown>]> = [
      ['error', ragErrorSchema, ragError],
      ['local status', localIndexStatusSchema, localReady()],
      ['semantic status', semanticIndexStatusSchema, semanticReady()],
      ['scope', ragScopeSchema, { kind: 'current-document', documentId }],
      ['citation', citationSchema, citation()],
      ['selection', selectionRequestSchema, selectionRequest()],
      ['stream', ragStreamEventSchema, { requestId, sequence: 0, type: 'accepted' }]
    ]
    for (const [name, schema, value] of samples) {
      expect(() => schema.parse({ ...value, unexpected: true }), name).toThrow()
    }
  })
})

describe('RAG bounded answer stream and stable errors', () => {
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
    expect(RAG_ERROR_CODES).toHaveLength(24)
    for (const code of RAG_ERROR_CODES) {
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
