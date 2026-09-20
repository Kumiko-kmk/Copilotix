import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  ArtifactRepositoryPort,
  ArtifactStorePort,
  CitationResolverPort,
  ClockPort,
  ChunkerPort,
  ComputePort,
  CredentialVaultPort,
  DocumentRepositoryPort,
  IdGeneratorPort,
  JobRepositoryPort,
  LexicalIndexPort,
  ParserPort,
  PathPolicyPort,
  RetrieverPort,
  TranslationProviderPort,
  VectorStorePort
} from '@core/ports'
import type {
  ArtifactRevision,
  Document,
  Job,
  RagVectorEntry,
  RagVectorSearchInput
} from '@core/types'

const document: Document = {
  id: 'document-1',
  originalFilename: 'paper.pdf',
  displayTitle: null,
  storagePath: 'C:/documents-v2/document-1',
  sourceChecksum: 'sha256',
  translationProvider: 'qwen',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

const job: Job = {
  id: 'job-1',
  documentId: document.id,
  kind: 'parse',
  status: 'queued',
  progress: 0,
  dependsOnJobId: null,
  priority: 0,
  attempt: 0,
  maxAttempts: 5,
  payload: {},
  checkpoint: {},
  availableAt: document.createdAt,
  leaseOwner: null,
  leaseExpiresAt: null,
  errorCode: null,
  errorMessage: null,
  startedAt: null,
  finishedAt: null,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt
}

const revision: ArtifactRevision = {
  id: 'artifact-1',
  documentId: document.id,
  kind: 'source_pdf',
  revision: 1,
  relativePath: 'original.pdf',
  contentHash: 'sha256',
  createdByJobId: job.id,
  metadata: {},
  createdAt: document.createdAt
}

describe('core ports', () => {
  it('keeps infrastructure-facing contracts independent from the legacy TaskRepository', () => {
    const documents: DocumentRepositoryPort = {
      create: () => undefined,
      get: () => document,
      list: () => [document],
      update: () => document,
      delete: () => undefined
    }
    const jobs: JobRepositoryPort = {
      enqueue: () => job,
      get: () => job,
      list: () => [job],
      claimBatch: () => [job],
      heartbeat: () => job,
      updateProgressAndCheckpoint: () => job,
      complete: () => job,
      failOrRetry: () => job,
      cancel: () => job,
      manualRetry: () => job,
      recoverExpired: () => [job],
      listEvents: () => []
    }
    const artifacts: ArtifactRepositoryPort = {
      create: () => undefined,
      get: () => revision,
      list: () => [revision],
      latest: () => revision
    }
    const store: ArtifactStorePort = {
      commitFile: async () => revision,
      writeText: async () => revision,
      readText: async () => 'text'
    }
    const parser: ParserPort = {
      submit: async () => ({ remoteBatchId: 'batch', remoteDataId: 'data' }),
      poll: async () => ({ status: 'running', progress: 0 })
    }
    const translation: TranslationProviderPort = {
      id: 'qwen',
      isAvailable: async () => true,
      translate: async (text) => text
    }
    const vault: CredentialVaultPort = {
      get: async () => null,
      has: async () => false,
      set: async () => undefined,
      delete: async () => undefined
    }
    const compute: ComputePort = { run: async (_name, input) => input as never }
    const clock: ClockPort = { now: () => document.createdAt }
    const ids: IdGeneratorPort = { next: () => 'id' }
    const paths: PathPolicyPort = { resolveChild: (_root, candidate) => candidate }
    expect([documents, jobs, artifacts, store, parser, translation, vault, compute, clock, ids, paths]).toHaveLength(11)
  })

  it('exposes minimal RAG ports and keeps vector queries Utility-internal', async () => {
    const chunker: ChunkerPort = { chunk: async () => [] }
    const lexicalIndex: LexicalIndexPort = {
      rebuild: async () => undefined,
      search: async () => ({ kind: 'lexical', items: [], nextCursor: null, total: 0 }),
      delete: async () => undefined
    }
    const vectorQuery: RagVectorSearchInput = {
      vectorIndexId: 'vector-index-1',
      contentRevisionId: 'content-revision-1',
      profileId: 'profile-1',
      queryVector: new Float32Array([0.25, 0.75]),
      limit: 5
    }
    const vectorEntry: RagVectorEntry = {
      vectorIndexId: vectorQuery.vectorIndexId,
      contentRevisionId: vectorQuery.contentRevisionId,
      profileId: vectorQuery.profileId,
      chunkId: 'chunk-1',
      vector: new Float32Array([0.5, 0.5])
    }
    const vectorStore: VectorStorePort = {
      upsert: async (entries) => {
        expect(entries).toHaveLength(1)
        expect(entries[0]?.profileId).toBe(vectorQuery.profileId)
      },
      search: async (input) => {
        expect(input.queryVector).toBeInstanceOf(Float32Array)
        return { candidates: [] }
      },
      delete: async () => undefined
    }
    const retriever: RetrieverPort = {
      retrieve: async () => ({ kind: 'lexical', items: [], nextCursor: null, total: 0 })
    }
    const citationResolver: CitationResolverPort = { resolve: async () => [] }

    expect([chunker, lexicalIndex, vectorStore, retriever, citationResolver]).toHaveLength(5)
    expectTypeOf(vectorQuery.queryVector).toEqualTypeOf<Float32Array>()
    await vectorStore.upsert([vectorEntry])
    await expect(vectorStore.search(vectorQuery)).resolves.toEqual({ candidates: [] })
  })
})
