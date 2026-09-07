import { describe, expect, it } from 'vitest'
import type {
  ArtifactRepositoryPort,
  ArtifactStorePort,
  ClockPort,
  ComputePort,
  CredentialVaultPort,
  DocumentRepositoryPort,
  IdGeneratorPort,
  JobRepositoryPort,
  ParserPort,
  PathPolicyPort,
  TranslationProviderPort
} from '@core/ports'
import type { ArtifactRevision, Document, Job } from '@core/types'

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
})
