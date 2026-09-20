import { createHash } from 'node:crypto'
import type { Job, JobStatus } from '@core/types'
import type { SemanticIndexState } from '@shared/ragTypes'
import {
  type RagDocumentKnowledge,
  type RagProfileRecord,
  type RagVectorIndexRecord,
  type RagVectorIndexState,
  SqliteRagRepository,
  SqliteRagRepositoryError
} from './persistence/sqliteRagRepository'
import { SqliteJobRepository } from './persistence/sqliteJobRepository'
import { V2Database } from './persistence/v2Database'

/**
 * The result intentionally contains only durable identities and state.  The
 * embedding bytes, source text, credentials, and filesystem paths stay in the
 * Utility process and never become RPC data.
 */
export interface EnsureEmbeddingJobResult {
  documentId: string
  profileId: string
  contentRevisionId: string
  vectorIndexId: string
  jobId: string
  jobKind: 'rag-embed'
  jobStatus: JobStatus
  vectorIndexState: RagVectorIndexState
  semanticState: SemanticIndexState
}

/**
 * Utility-owned RAG lifecycle boundary.  It is deliberately separate from
 * the persistence repository: this class decides whether a semantic job is
 * allowed to exist, while the repository remains reusable for lower-level
 * state transitions used by a future runner.
 */
export class RagDomainService {
  constructor(
    private readonly database: V2Database,
    private readonly ragRepository: SqliteRagRepository,
    private readonly jobRepository: SqliteJobRepository
  ) {}

  getKnowledge(documentId: string): RagDocumentKnowledge | null {
    validateIdentifier(documentId, 'document id')
    const document = this.database.connection.prepare('SELECT 1 AS present FROM documents WHERE id=?').get(documentId) as { present: number } | undefined
    if (!document) return null
    return this.ragRepository.getDocumentKnowledge(documentId) ?? this.ragRepository.ensureDocumentKnowledge(documentId)
  }

  setSemanticConsent(documentId: string, consent: boolean, now?: string): RagDocumentKnowledge {
    validateIdentifier(documentId, 'document id')
    if (typeof consent !== 'boolean') throw ragError('RAG_INVALID_SEMANTIC_CONSENT', 'Semantic consent must be boolean')
    const timestamp = validateTimestamp(now ?? new Date().toISOString(), 'semantic consent time')
    return this.database.transaction(() => {
      const document = this.database.connection.prepare('SELECT 1 AS present FROM documents WHERE id=?').get(documentId) as { present: number } | undefined
      if (!document) throw ragError('DOCUMENT_NOT_FOUND', 'Document does not exist')
      this.database.connection.prepare(
        'INSERT INTO rag_documents(document_id,updated_at) VALUES(?,?) ON CONFLICT(document_id) DO NOTHING'
      ).run(documentId, timestamp)
      const current = this.ragRepository.getDocumentKnowledge(documentId)
      if (!current) throw ragError('RAG_DOCUMENT_NOT_FOUND', 'RAG document row does not exist')
      const nextState: SemanticIndexState = consent
        ? current.semanticState === 'disabled' || current.semanticState === 'requires-consent' || current.semanticState === 'failed'
          ? 'requires-credential'
          : current.semanticState
        : 'requires-consent'
      const noSemanticIdentity = nextState === 'requires-consent' || nextState === 'requires-credential'
      const keepIdentity = consent && !noSemanticIdentity
      this.database.connection.prepare(`
        UPDATE rag_documents SET
          semantic_consent=?, semantic_state=?, semantic_progress=?,
          semantic_error_code=NULL, semantic_error_message=NULL,
          semantic_error_retryable=NULL, semantic_error_retry_after_ms=NULL,
          semantic_content_revision_id=?, active_vector_index_id=?, semantic_profile_id=?, updated_at=?
        WHERE document_id=?
      `).run(
        consent ? 1 : 0,
        nextState,
        keepIdentity ? current.semanticProgress : 0,
        keepIdentity ? current.semanticContentRevisionId : null,
        keepIdentity ? current.activeVectorIndexId : null,
        keepIdentity ? current.semanticProfileId : null,
        timestamp,
        documentId
      )
      if (!consent) {
        const activeJobs = this.database.connection.prepare(`
          SELECT id FROM jobs WHERE document_id=? AND kind='rag-embed'
            AND status NOT IN ('succeeded','partial','failed','cancelled')
        `).all(documentId) as Array<{ id: string }>
        for (const active of activeJobs) {
          this.jobRepository.supersedeWithinTransaction({
            jobId: active.id,
            now: timestamp,
            errorCode: 'SEMANTIC_CONSENT_REVOKED',
            errorMessage: 'Semantic indexing consent was revoked',
            detail: { consent: false }
          })
        }
      }
      const result = this.ragRepository.getDocumentKnowledge(documentId)
      if (!result) throw ragError('RAG_DOCUMENT_NOT_FOUND', 'RAG document row does not exist')
      return result
    })
  }

  /**
   * Check every semantic prerequisite before any vector/job write.  The
   * checks and the vector/job/status writes then share one BEGIN IMMEDIATE
   * transaction, so two callers cannot create competing active embed jobs.
   */
  ensureEmbeddingJob(input: {
    documentId: string
    profileId: string
    now?: string
  }): EnsureEmbeddingJobResult {
    const documentId = validateIdentifier(input.documentId, 'document id')
    const profileId = validateIdentifier(input.profileId, 'profile id')
    const now = validateTimestamp(input.now ?? new Date().toISOString(), 'embedding job time')

    // This read also distinguishes a missing document from a document that
    // simply has not received its first parsed bundle yet.
    const knowledge = this.getKnowledge(documentId)
    if (!knowledge) throw ragError('DOCUMENT_NOT_FOUND', 'Document does not exist')
    if (knowledge.localState !== 'ready' || knowledge.localProgress !== 100 || !knowledge.activeContentRevisionId) {
      throw ragError('RAG_CONTENT_NOT_READY', 'A ready local content revision is required before embedding')
    }

    const revision = this.ragRepository.getContentRevision(knowledge.activeContentRevisionId)
    if (!revision || revision.documentId !== documentId || revision.state !== 'ready') {
      throw ragError('RAG_CONTENT_NOT_READY', 'The active local content revision is not ready')
    }
    if (!knowledge.semanticConsent) throw ragError('SEMANTIC_CONSENT_REQUIRED', 'Semantic indexing requires explicit user consent')

    const profile = this.ragRepository.getProfile(profileId)
    assertEmbeddingProfile(profile)

    const identity = JSON.stringify([documentId, revision.contentRevisionId, profileId])
    const digest = createHash('sha256').update(identity).digest('hex')
    const vectorIndexId = `rag-vector-index-${digest}`
    const jobId = `rag-embed-job-${digest}`

    return this.database.transaction(() => {
      // Re-read all authority-bearing rows inside the write transaction.  A
      // concurrent parser publication or consent revocation must win over the
      // optimistic reads above and prevent a job from being inserted.
      const current = this.ragRepository.getDocumentKnowledge(documentId)
      if (!current || current.localState !== 'ready' || current.localProgress !== 100 || current.activeContentRevisionId !== revision.contentRevisionId) {
        throw ragError('RAG_CONTENT_NOT_READY', 'The local content revision changed before embedding was queued')
      }
      if (!current.semanticConsent) throw ragError('SEMANTIC_CONSENT_REQUIRED', 'Semantic indexing requires explicit user consent')
      const currentProfile = this.ragRepository.getProfile(profileId)
      assertEmbeddingProfile(currentProfile)
      const currentRevision = this.ragRepository.getContentRevision(revision.contentRevisionId)
      if (!currentRevision || currentRevision.state !== 'ready' || currentRevision.documentId !== documentId) {
        throw ragError('RAG_CONTENT_NOT_READY', 'The local content revision changed before embedding was queued')
      }

      const vectorIndex = this.ensureVectorIndexWithinTransaction({
        documentId,
        revisionId: currentRevision.contentRevisionId,
        profile: currentProfile,
        vectorIndexId,
        now
      })

      // Only one active job of each kind is allowed by the database partial
      // unique index.  Obsolete semantic jobs must be terminal before the
      // current identity is inserted, otherwise a new revision would race an
      // old queued/retry-wait job.
      this.supersedeObsoleteEmbeddingJobs(documentId, profileId, currentRevision.contentRevisionId, jobId, now)

      const existingJob = this.jobRepository.get(jobId)
      let job: Job
      if (existingJob) {
        if (existingJob.documentId !== documentId || existingJob.kind !== 'rag-embed') {
          throw ragError('RAG_EMBED_JOB_ID_CONFLICT', 'Embedding job identity is already used by another job')
        }
        const needsRecovery = existingJob.status === 'partial' || existingJob.status === 'failed' || existingJob.status === 'cancelled' ||
          (existingJob.status === 'succeeded' && vectorIndex.state !== 'ready')
        job = needsRecovery
          ? this.jobRepository.requeueWithinTransaction({
              jobId,
              now,
              detail: { contentRevisionId: currentRevision.contentRevisionId, profileId }
            })
          : existingJob
      } else {
        job = this.jobRepository.enqueueWithinTransaction({
          id: jobId,
          documentId,
          kind: 'rag-embed',
          priority: -200,
          payload: {
            contentRevisionId: currentRevision.contentRevisionId,
            profileId,
            vectorIndexId: vectorIndex.vectorIndexId
          },
          checkpoint: {
            phase: 'queued',
            contentRevisionId: currentRevision.contentRevisionId,
            profileId,
            vectorIndexId: vectorIndex.vectorIndexId
          },
          now
        })
      }

      // A completed deterministic job plus a ready vector is already an
      // idempotent success.  Preserve that state on repeated ensure calls;
      // otherwise queue the semantic-only lifecycle.  In either branch the
      // local ready state is never rewritten.
      if (job.status === 'succeeded' && vectorIndex.state === 'ready') {
        this.database.connection.prepare(`
          UPDATE rag_documents SET
            semantic_state='ready', semantic_progress=100,
            semantic_error_code=NULL, semantic_error_message=NULL,
            semantic_error_retryable=NULL, semantic_error_retry_after_ms=NULL,
            semantic_content_revision_id=?, active_vector_index_id=?, semantic_profile_id=?, updated_at=?
          WHERE document_id=?
        `).run(currentRevision.contentRevisionId, vectorIndex.vectorIndexId, profileId, now, documentId)
      } else {
        this.database.connection.prepare(`
          UPDATE rag_documents SET
            semantic_state='queued', semantic_progress=0,
            semantic_error_code=NULL, semantic_error_message=NULL,
            semantic_error_retryable=NULL, semantic_error_retry_after_ms=NULL,
            semantic_content_revision_id=?, active_vector_index_id=?, semantic_profile_id=?, updated_at=?
          WHERE document_id=?
        `).run(currentRevision.contentRevisionId, vectorIndex.vectorIndexId, profileId, now, documentId)
      }

      const finalKnowledge = this.ragRepository.getDocumentKnowledge(documentId)
      if (!finalKnowledge) throw ragError('RAG_DOCUMENT_NOT_FOUND', 'RAG document row does not exist')
      return {
        documentId,
        profileId,
        contentRevisionId: currentRevision.contentRevisionId,
        vectorIndexId: vectorIndex.vectorIndexId,
        jobId: job.id,
        jobKind: 'rag-embed' as const,
        jobStatus: job.status,
        vectorIndexState: vectorIndex.state,
        semanticState: finalKnowledge.semanticState
      }
    })
  }

  private ensureVectorIndexWithinTransaction(input: {
    documentId: string
    revisionId: string
    profile: RagProfileRecord
    vectorIndexId: string
    now: string
  }): RagVectorIndexRecord {
    const existing = this.database.connection.prepare(`
      SELECT vector_index_id,document_id,content_revision_id,profile_id,backend,
        dimensions,metric,normalized,state,error_code,error_message,created_at,updated_at
      FROM rag_vector_indexes
      WHERE document_id=? AND content_revision_id=? AND profile_id=?
    `).get(input.documentId, input.revisionId, input.profile.profileId) as VectorIndexRow | undefined
    if (existing && (
      existing.dimensions !== input.profile.dimensions ||
      existing.metric !== input.profile.metric ||
      existing.normalized !== (input.profile.normalized ? 1 : 0)
    )) {
      throw ragError('RAG_PROFILE_MISMATCH', 'Existing vector index metadata does not match the embedding profile')
    }

    if (existing && existing.vector_index_id !== input.vectorIndexId) {
      // The identity unique constraint is authoritative.  A deterministic ID
      // mismatch can only indicate data written by an older build, so reuse
      // the persisted row instead of creating a duplicate index.
      return vectorIndexFromRow(existing)
    }

    if (!existing) {
      try {
        this.database.connection.prepare(`
          INSERT INTO rag_vector_indexes(
            vector_index_id,document_id,content_revision_id,profile_id,backend,
            dimensions,metric,normalized,state,error_code,error_message,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?, 'queued',NULL,NULL,?,?)
        `).run(
          input.vectorIndexId,
          input.documentId,
          input.revisionId,
          input.profile.profileId,
          'sqlite-exact',
          input.profile.dimensions!,
          input.profile.metric,
          input.profile.normalized ? 1 : 0,
          input.now,
          input.now
        )
      } catch (error) {
        if (!isConstraintError(error)) throw error
        const concurrent = this.database.connection.prepare(`
          SELECT vector_index_id,document_id,content_revision_id,profile_id,backend,
            dimensions,metric,normalized,state,error_code,error_message,created_at,updated_at
          FROM rag_vector_indexes
          WHERE document_id=? AND content_revision_id=? AND profile_id=?
        `).get(input.documentId, input.revisionId, input.profile.profileId) as VectorIndexRow | undefined
        if (concurrent) return vectorIndexFromRow(concurrent)
        throw ragError('RAG_VECTOR_INDEX_EXISTS', 'Vector index could not be created', true)
      }
    } else if (existing.state === 'failed' || existing.state === 'stale') {
      // A valid ensure call is an explicit request to resume a stale/failed
      // identity.  Keep the same vector identity and clear only vector error.
      this.database.connection.prepare(`
        UPDATE rag_vector_indexes SET state='queued',error_code=NULL,error_message=NULL,updated_at=?
        WHERE vector_index_id=?
      `).run(input.now, existing.vector_index_id)
    }

    const row = this.database.connection.prepare(`
      SELECT vector_index_id,document_id,content_revision_id,profile_id,backend,
        dimensions,metric,normalized,state,error_code,error_message,created_at,updated_at
      FROM rag_vector_indexes WHERE vector_index_id=?
    `).get(input.vectorIndexId) as VectorIndexRow | undefined
    if (!row) throw ragError('RAG_VECTOR_INDEX_NOT_FOUND', 'Vector index was not persisted')
    return vectorIndexFromRow(row)
  }

  private supersedeObsoleteEmbeddingJobs(
    documentId: string,
    profileId: string,
    contentRevisionId: string,
    replacementJobId: string,
    now: string
  ): void {
    const active = this.database.connection.prepare(`
      SELECT id,payload_json FROM jobs
      WHERE document_id=? AND kind='rag-embed'
        AND status NOT IN ('succeeded','partial','failed','cancelled') AND id<>?
    `).all(documentId, replacementJobId) as Array<{ id: string; payload_json: string }>
    for (const row of active) {
      const payload = parseJsonObject(row.payload_json)
      if (payload.profileId === profileId && payload.contentRevisionId === contentRevisionId) continue
      this.jobRepository.supersedeWithinTransaction({
        jobId: row.id,
        now,
        errorCode: 'RAG_EMBED_SUPERSEDED',
        errorMessage: 'Embedding request was superseded by a newer semantic identity',
        detail: { replacementJobId, contentRevisionId, profileId }
      })
    }
  }
}

interface VectorIndexRow {
  vector_index_id: string
  document_id: string
  content_revision_id: string
  profile_id: string
  backend: string
  dimensions: number
  metric: 'cosine' | 'dot' | 'l2'
  normalized: number
  state: RagVectorIndexState
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

function vectorIndexFromRow(row: VectorIndexRow): RagVectorIndexRecord {
  return {
    vectorIndexId: row.vector_index_id,
    documentId: row.document_id,
    contentRevisionId: row.content_revision_id,
    profileId: row.profile_id,
    backend: row.backend,
    dimensions: row.dimensions,
    metric: row.metric,
    normalized: row.normalized === 1,
    state: row.state,
    error: row.error_code === null && row.error_message === null
      ? null
      : {
          code: row.error_code ?? 'RAG_DATA_INVALID',
          message: row.error_message ?? 'Stored vector error is incomplete',
          retryable: false,
          retryAfterMs: null
        },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function assertEmbeddingProfile(profile: RagProfileRecord | null): asserts profile is RagProfileRecord {
  if (!profile) throw ragError('RAG_PROFILE_NOT_FOUND', 'Embedding profile does not exist')
  if (profile.capability !== 'embedding') throw ragError('RAG_PROFILE_CAPABILITY_INVALID', 'Profile is not an embedding profile')
  if (profile.status !== 'valid') throw ragError('RAG_PROFILE_INVALID', 'Embedding profile is not valid')
  if (!profile.credentialRef || profile.credentialRef.trim().length === 0) {
    throw ragError('EMBEDDING_CREDENTIALS_REQUIRED', 'Embedding profile has no credential reference')
  }
  if (profile.dimensions === null || !Number.isInteger(profile.dimensions) || profile.dimensions <= 0) {
    throw ragError('RAG_PROFILE_DIMENSIONS_INVALID', 'Embedding profile dimensions are invalid')
  }
}

function validateIdentifier(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\0')) {
    throw ragError('RAG_INVALID_INPUT', `Invalid ${label}`)
  }
  return value
}

function validateTimestamp(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || value.includes('\0')) {
    throw ragError('RAG_INVALID_INPUT', `Invalid ${label}`)
  }
  return value
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function isConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && /constraint|unique/iu.test(String((error as { message?: unknown }).message ?? '')))
}

function ragError(code: string, message: string, retryable = false): SqliteRagRepositoryError {
  return new SqliteRagRepositoryError(code, message, retryable)
}
