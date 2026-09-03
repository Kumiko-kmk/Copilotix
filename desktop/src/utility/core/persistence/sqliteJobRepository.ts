import { randomUUID } from 'node:crypto'
import type { StatementSync } from 'node:sqlite'
import type {
  JobCancelInput,
  JobCompleteInput,
  JobEnqueueInput,
  JobFailOrRetryInput,
  JobHeartbeatInput,
  JobListQuery,
  JobManualRetryInput,
  JobProgressCheckpointInput,
  JobRecoverExpiredInput,
  JobRepositoryPort
} from '@core/jobs'
import {
  JOB_MANUAL_RETRY_TRANSITIONS,
  JOB_STATUS_TRANSITIONS,
  type JobTransition
} from '@core/jobs'
import type { Job, JobEvent, JobKind, JobStatus, JsonObject } from '@core/types'
import { V2Database } from './v2Database'

const MAX_JOB_JSON_BYTES = 64 * 1024
const MAX_ERROR_MESSAGE_BYTES = 4 * 1024
const MAX_EVENT_DETAIL_BYTES = 16 * 1024
const MAX_CLAIM_LIMIT = 50
const DEFAULT_MAX_ATTEMPTS = 5

type JobRow = {
  id: string
  document_id: string
  depends_on_job_id: string | null
  kind: JobKind
  status: JobStatus
  progress: number
  priority: number
  attempt: number
  max_attempts: number
  payload_json: string
  checkpoint_json: string
  available_at: string
  lease_owner: string | null
  lease_expires_at: string | null
  error_code: string | null
  error_message: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

type EventRow = {
  id: string
  job_id: string
  sequence: number
  from_state: JobStatus | null
  to_state: JobStatus
  detail_json: string
  created_at: string
}

export class SqliteJobRepositoryError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message)
    this.name = 'SqliteJobRepositoryError'
  }
}

/**
 * Utility-owned durable job repository. Every mutating state transition and
 * its event are committed in one BEGIN IMMEDIATE transaction.
 */
export class SqliteJobRepository implements JobRepositoryPort {
  private readonly selectById: StatementSync
  private readonly listAll: StatementSync
  private readonly claimCandidates: StatementSync
  private readonly readyRetries: StatementSync
  private readonly selectExpired: StatementSync
  private readonly selectNextSequence: StatementSync
  private readonly selectEvents: StatementSync
  private readonly insertJob: StatementSync
  private readonly updateClaim: StatementSync
  private readonly promoteRetry: StatementSync
  private readonly updateHeartbeat: StatementSync
  private readonly updateProgress: StatementSync
  private readonly updateTransition: StatementSync
  private readonly updateManualAttempt: StatementSync
  private readonly insertEvent: StatementSync

  constructor(private readonly database: V2Database) {
    const connection = database.connection
    this.selectById = connection.prepare('SELECT * FROM jobs WHERE id=?')
    this.listAll = connection.prepare('SELECT * FROM jobs ORDER BY priority DESC,created_at ASC,id ASC')
    this.claimCandidates = connection.prepare(`
      SELECT j.*
      FROM jobs j
      WHERE j.status='queued'
        AND j.available_at<=?
        AND (? IS NULL OR j.kind=?)
        AND (
          j.depends_on_job_id IS NULL
          OR EXISTS (
            SELECT 1 FROM jobs dependency
            WHERE dependency.id=j.depends_on_job_id
              AND dependency.document_id=j.document_id
              AND dependency.status IN ('succeeded','partial')
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM jobs active
          WHERE active.document_id=j.document_id AND active.status='running'
        )
      ORDER BY j.priority DESC,j.created_at ASC,j.id ASC
      LIMIT ?
    `)
    this.readyRetries = connection.prepare(`
      SELECT * FROM jobs
      WHERE status='retry-wait' AND available_at<=?
      ORDER BY priority DESC,created_at ASC,id ASC
    `)
    this.selectExpired = connection.prepare(`
      SELECT * FROM jobs
      WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?
      ORDER BY priority DESC,created_at ASC,id ASC
    `)
    this.selectNextSequence = connection.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM job_events WHERE job_id=?')
    this.selectEvents = connection.prepare('SELECT * FROM job_events WHERE job_id=? ORDER BY sequence ASC')
    this.insertJob = connection.prepare(`
      INSERT INTO jobs(
        id,document_id,depends_on_job_id,kind,status,progress,priority,attempt,max_attempts,payload_json,checkpoint_json,
        available_at,lease_owner,lease_expires_at,error_code,error_message,started_at,finished_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `)
    this.updateClaim = connection.prepare(`
      UPDATE jobs SET
        status='running',attempt=attempt+1,lease_owner=?,lease_expires_at=?,
        started_at=COALESCE(started_at,?),finished_at=NULL,error_code=NULL,error_message=NULL,updated_at=?
      WHERE id=? AND status='queued'
    `)
    this.promoteRetry = connection.prepare(`
      UPDATE jobs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,finished_at=NULL,updated_at=?
      WHERE id=? AND status='retry-wait' AND available_at<=?
    `)
    this.updateHeartbeat = connection.prepare(`
      UPDATE jobs SET lease_expires_at=?,updated_at=?
      WHERE id=? AND status='running' AND lease_owner=?
    `)
    this.updateProgress = connection.prepare(`
      UPDATE jobs SET progress=?,checkpoint_json=?,updated_at=?
      WHERE id=? AND status='running' AND lease_owner=?
    `)
    this.updateTransition = connection.prepare(`
      UPDATE jobs SET
        status=?,progress=?,checkpoint_json=?,available_at=?,lease_owner=?,lease_expires_at=?,
        error_code=?,error_message=?,started_at=?,finished_at=?,updated_at=?
      WHERE id=?
    `)
    this.updateManualAttempt = connection.prepare('UPDATE jobs SET attempt=attempt+1 WHERE id=?')
    this.insertEvent = connection.prepare(`
      INSERT INTO job_events(id,job_id,sequence,from_state,to_state,detail_json,created_at)
      VALUES(?,?,?,?,?,?,?)
    `)
  }

  enqueue(input: JobEnqueueInput): Job {
    const id = validateIdentifier(input.id ?? randomUUID(), 'job id')
    const documentId = validateIdentifier(input.documentId, 'document id')
    const kind = validateKind(input.kind)
    const now = validateTimestamp(input.now ?? new Date().toISOString(), 'created time')
    const availableAt = validateTimestamp(input.availableAt ?? now, 'available time')
    const maxAttempts = validateAttempts(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    const priority = validateInteger(input.priority ?? 0, -1_000_000, 1_000_000, 'priority')
    const payload = serializeJobJson(input.payload ?? {}, 'payload')
    const checkpoint = serializeJobJson(input.checkpoint ?? {}, 'checkpoint')
    const dependsOnJobId = input.dependsOnJobId == null ? null : validateIdentifier(input.dependsOnJobId, 'dependency job id')

    return this.database.transaction(() => {
      const existing = this.getUnsafe(id)
      if (existing) {
        if (existing.documentId !== documentId || existing.kind !== kind) {
          throw new SqliteJobRepositoryError('JOB_ID_CONFLICT', 'Job ID is already used by another job')
        }
        return existing
      }
      try {
        this.insertJob.run(
          id, documentId, dependsOnJobId, kind, 'queued', 0, priority, 0, maxAttempts,
          payload, checkpoint, availableAt, null, null, null, null, null, null, now, now
        )
      } catch (error) {
        if (isConstraintError(error)) throw new SqliteJobRepositoryError('JOB_ACTIVE_EXISTS', 'An active job already exists for this document and kind')
        throw new SqliteJobRepositoryError('JOB_ENQUEUE_FAILED', 'Job could not be queued', true)
      }
      this.appendEventUnsafe({
        jobId: id,
        fromState: null,
        toState: 'queued',
        detail: { kind },
        createdAt: now
      })
      return this.getUnsafe(id)!
    })
  }

  get(id: string): Job | null {
    return this.getUnsafe(validateIdentifier(id, 'job id'))
  }

  list(query: JobListQuery = {}): Job[] {
    const documentId = query.documentId == null ? undefined : validateIdentifier(query.documentId, 'document id')
    const kind = query.kind == null ? undefined : validateKind(query.kind)
    const statuses = query.statuses?.map((status) => validateStatus(status))
    const limit = validateInteger(query.limit ?? 10_000, 1, 10_000, 'list limit')
    const rows = this.listAll.all() as unknown as JobRow[]
    return rows
      .filter((row) => documentId === undefined || row.document_id === documentId)
      .filter((row) => kind === undefined || row.kind === kind)
      .filter((row) => statuses === undefined || statuses.includes(row.status))
      .slice(0, limit)
      .map((row) => fromJobRow(row))
  }

  claimBatch(input: { now: string; leaseOwner: string; leaseExpiresAt: string; limit?: number; kind?: JobKind }): Job[] {
    const now = validateTimestamp(input.now, 'claim time')
    const leaseOwner = validateLeaseOwner(input.leaseOwner)
    const leaseExpiresAt = validateTimestamp(input.leaseExpiresAt, 'lease expiry')
    const limit = validateInteger(input.limit ?? 1, 1, MAX_CLAIM_LIMIT, 'claim limit')
    const kind = input.kind == null ? null : validateKind(input.kind)

    return this.database.transaction(() => {
      this.promoteReadyRetriesUnsafe(now)
      const candidates = this.claimCandidates.all(now, kind, kind, limit) as unknown as JobRow[]
      const claimedDocuments = new Set<string>()
      const claimed: Job[] = []
      for (const candidate of candidates) {
        if (claimedDocuments.has(candidate.document_id)) continue
        const result = this.updateClaim.run(leaseOwner, leaseExpiresAt, now, now, candidate.id) as { changes?: number }
        if (result.changes !== 1) continue
        const job = this.getUnsafe(candidate.id)
        if (!job) continue
        claimedDocuments.add(job.documentId)
        this.appendEventUnsafe({
          jobId: job.id,
          fromState: 'queued',
          toState: 'running',
          detail: { attempt: job.attempt, leaseOwner },
          createdAt: now
        })
        claimed.push(job)
      }
      return claimed
    })
  }

  heartbeat(input: JobHeartbeatInput): Job {
    const jobId = validateIdentifier(input.jobId, 'job id')
    const owner = validateLeaseOwner(input.leaseOwner)
    const leaseExpiresAt = validateTimestamp(input.leaseExpiresAt, 'lease expiry')
    const now = validateTimestamp(input.now ?? new Date().toISOString(), 'heartbeat time')
    return this.database.transaction(() => {
      const current = this.requireJobUnsafe(jobId)
      if (current.status !== 'running' || current.leaseOwner !== owner) throw leaseLost()
      const result = this.updateHeartbeat.run(leaseExpiresAt, now, jobId, owner) as { changes?: number }
      if (result.changes !== 1) throw leaseLost()
      return this.getUnsafe(jobId)!
    })
  }

  updateProgressAndCheckpoint(input: JobProgressCheckpointInput): Job {
    const jobId = validateIdentifier(input.jobId, 'job id')
    const owner = validateLeaseOwner(input.leaseOwner)
    const progress = validateInteger(input.progress, 0, 100, 'progress')
    const checkpoint = serializeJobJson(input.checkpoint, 'checkpoint')
    const now = validateTimestamp(input.now ?? new Date().toISOString(), 'progress time')
    return this.database.transaction(() => {
      const current = this.requireJobUnsafe(jobId)
      if (current.status !== 'running' || current.leaseOwner !== owner) throw leaseLost()
      const result = this.updateProgress.run(progress, checkpoint, now, jobId, owner) as { changes?: number }
      if (result.changes !== 1) throw leaseLost()
      return this.getUnsafe(jobId)!
    })
  }

  complete(input: JobCompleteInput): Job {
    const jobId = validateIdentifier(input.jobId, 'job id')
    const owner = validateLeaseOwner(input.leaseOwner)
    const status = input.status === 'partial' ? 'partial' : input.status === 'succeeded' ? 'succeeded' : validateStatus(input.status)
    const now = validateTimestamp(input.now ?? new Date().toISOString(), 'completion time')
    return this.database.transaction(() => {
      const current = this.requireJobUnsafe(jobId)
      if (current.status === status) return current
      if (current.status !== 'running' || current.leaseOwner !== owner) throw leaseLost()
      assertTransition(current.status, status)
      const progress = validateInteger(input.progress ?? (status === 'succeeded' ? 100 : current.progress), 0, 100, 'progress')
      const checkpoint = serializeJobJson(input.checkpoint ?? current.checkpoint, 'checkpoint')
      this.updateTransition.run(
        status, progress, checkpoint, current.availableAt, null, null, null, null,
        current.startedAt ?? now, now, now, jobId
      )
      this.appendEventUnsafe({
        jobId,
        fromState: current.status,
        toState: status,
        detail: sanitizeDetail(input.detail ?? {}, { progress }),
        createdAt: now
      })
      return this.getUnsafe(jobId)!
    })
  }

  failOrRetry(input: JobFailOrRetryInput): Job {
    const jobId = validateIdentifier(input.jobId, 'job id')
    const owner = validateLeaseOwner(input.leaseOwner)
    const errorCode = sanitizeErrorCode(input.errorCode)
    const errorMessage = sanitizeErrorMessage(input.errorMessage)
    const now = validateTimestamp(input.now ?? new Date().toISOString(), 'failure time')
    return this.database.transaction(() => {
      const current = this.requireJobUnsafe(jobId)
      if (current.status !== 'running' || current.leaseOwner !== owner) throw leaseLost()
      const toState: JobStatus = input.terminal || current.attempt >= current.maxAttempts ? 'failed' : 'retry-wait'
      const availableAt = validateTimestamp(input.availableAt ?? now, 'retry time')
      assertTransition(current.status, toState)
      this.updateTransition.run(
        toState, current.progress, JSON.stringify(current.checkpoint), availableAt, null, null,
        errorCode, errorMessage, current.startedAt ?? now, toState === 'failed' ? now : null, now, jobId
      )
      this.appendEventUnsafe({
        jobId,
        fromState: current.status,
        toState,
        detail: sanitizeDetail(input.detail ?? {}, { errorCode, retry: toState === 'retry-wait' }),
        createdAt: now
      })
      return this.getUnsafe(jobId)!
    })
  }

  cancel(input: JobCancelInput): Job {
    const jobId = validateIdentifier(input.jobId, 'job id')
    const owner = validateLeaseOwner(input.leaseOwner)
    const now = validateTimestamp(input.now ?? new Date().toISOString(), 'cancellation time')
    return this.database.transaction(() => {
      const current = this.requireJobUnsafe(jobId)
      if (current.status === 'cancelled') return current
      if (current.status !== 'running' || current.leaseOwner !== owner) throw leaseLost()
      assertTransition(current.status, 'cancelled')
      this.updateTransition.run(
        'cancelled', current.progress, JSON.stringify(current.checkpoint), current.availableAt, null, null,
        null, null, current.startedAt ?? now, now, now, jobId
      )
      this.appendEventUnsafe({
        jobId,
        fromState: current.status,
        toState: 'cancelled',
        detail: sanitizeDetail(input.detail ?? {}),
        createdAt: now
      })
      return this.getUnsafe(jobId)!
    })
  }

  manualRetry(input: JobManualRetryInput): Job {
    const jobId = validateIdentifier(input.jobId, 'job id')
    const now = validateTimestamp(input.now ?? new Date().toISOString(), 'manual retry time')
    const availableAt = validateTimestamp(input.availableAt ?? now, 'retry time')
    return this.database.transaction(() => {
      const current = this.requireJobUnsafe(jobId)
      const retryableStatus = current.status === 'failed' || current.status === 'cancelled' ? current.status : undefined
      const toState = retryableStatus ? JOB_MANUAL_RETRY_TRANSITIONS[retryableStatus] : null
      if (!toState) throw new SqliteJobRepositoryError('JOB_RETRY_NOT_ALLOWED', 'Only failed or cancelled jobs can be retried manually')
      assertTransition(current.status, toState, true)
      this.updateTransition.run(
        'queued', current.progress, JSON.stringify(current.checkpoint), availableAt, null, null,
        null, null, null, null, now, jobId
      )
      this.updateManualAttempt.run(jobId)
      this.appendEventUnsafe({
        jobId,
        fromState: current.status,
        toState: 'queued',
        detail: sanitizeDetail(input.detail ?? {}, { manual: true, attempt: current.attempt + 1 }),
        createdAt: now
      })
      return this.getUnsafe(jobId)!
    })
  }

  recoverExpired(input: JobRecoverExpiredInput): Job[] {
    const now = validateTimestamp(input.now, 'recovery time')
    return this.database.transaction(() => {
      const expired = this.selectExpired.all(now) as unknown as JobRow[]
      const recovered: Job[] = []
      for (const row of expired) {
        const current = this.getUnsafe(row.id)
        if (!current || current.status !== 'running' || !current.leaseExpiresAt || current.leaseExpiresAt > now) continue
        const toState: JobStatus = current.attempt < current.maxAttempts ? 'queued' : 'failed'
        const errorCode = 'LEASE_EXPIRED'
        const errorMessage = toState === 'failed'
          ? 'Job lease expired after the retry limit'
          : 'Job lease expired and was requeued'
        assertTransition(current.status, toState, false, true)
        this.updateTransition.run(
          toState, current.progress, JSON.stringify(current.checkpoint), now, null, null,
          errorCode, errorMessage, current.startedAt, toState === 'failed' ? now : null, now, current.id
        )
        this.appendEventUnsafe({
          jobId: current.id,
          fromState: current.status,
          toState,
          detail: { errorCode, recovered: true },
          createdAt: now
        })
        recovered.push(this.getUnsafe(current.id)!)
      }
      return recovered
    })
  }

  listEvents(jobId: string): JobEvent[] {
    const id = validateIdentifier(jobId, 'job id')
    if (!this.getUnsafe(id)) return []
    return (this.selectEvents.all(id) as unknown as EventRow[]).map(fromEventRow)
  }

  private getUnsafe(id: string): Job | null {
    const row = this.selectById.get(id) as JobRow | undefined
    return row ? fromJobRow(row) : null
  }

  private requireJobUnsafe(id: string): Job {
    const job = this.getUnsafe(id)
    if (!job) throw new SqliteJobRepositoryError('JOB_NOT_FOUND', 'Job does not exist')
    return job
  }

  private appendEventUnsafe(transition: JobTransition): void {
    const detail = serializeEventDetail(transition.detail)
    const sequenceRow = this.selectNextSequence.get(transition.jobId) as { sequence: number }
    this.insertEvent.run(
      randomUUID(), transition.jobId, sequenceRow.sequence, transition.fromState,
      transition.toState, detail, transition.createdAt
    )
  }

  private promoteReadyRetriesUnsafe(now: string): void {
    const rows = this.readyRetries.all(now) as unknown as JobRow[]
    for (const row of rows) {
      const result = this.promoteRetry.run(now, row.id, now) as { changes?: number }
      if (result.changes !== 1) continue
      this.appendEventUnsafe({
        jobId: row.id,
        fromState: 'retry-wait',
        toState: 'queued',
        detail: { retryReady: true },
        createdAt: now
      })
    }
  }
}

function fromJobRow(row: JobRow): Job {
  return {
    id: row.id,
    documentId: row.document_id,
    dependsOnJobId: row.depends_on_job_id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    priority: row.priority,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    payload: parseJsonObject(row.payload_json),
    checkpoint: parseJsonObject(row.checkpoint_json),
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function fromEventRow(row: EventRow): JobEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    sequence: row.sequence,
    fromState: row.from_state,
    toState: row.to_state,
    detail: parseJsonObject(row.detail_json),
    createdAt: row.created_at
  }
}

function assertTransition(from: JobStatus | null, to: JobStatus, manual = false, recovery = false): void {
  if (from === to) return
  if (recovery && from === 'running' && to === 'queued') return
  if (from === 'failed' || from === 'cancelled') {
    if (manual && JOB_MANUAL_RETRY_TRANSITIONS[from] === to) return
  } else if (from === null && to === 'queued') {
    return
  } else if (from !== null && JOB_STATUS_TRANSITIONS[from].includes(to)) {
    return
  }
  throw new SqliteJobRepositoryError('JOB_INVALID_TRANSITION', 'Job state transition is not allowed')
}

function validateKind(kind: JobKind): JobKind {
  if (kind !== 'parse' && kind !== 'translate') throw new SqliteJobRepositoryError('JOB_INVALID_KIND', 'Job kind is not supported')
  return kind
}

function validateStatus(status: JobStatus): JobStatus {
  if (!['queued', 'running', 'retry-wait', 'succeeded', 'partial', 'failed', 'cancelled'].includes(status)) {
    throw new SqliteJobRepositoryError('JOB_INVALID_STATUS', 'Job status is not supported')
  }
  return status
}

function validateIdentifier(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\0')) {
    throw new SqliteJobRepositoryError('JOB_INVALID_INPUT', `Invalid ${label}`)
  }
  return value
}

function validateLeaseOwner(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes('\0')) {
    throw new SqliteJobRepositoryError('JOB_INVALID_INPUT', 'Invalid lease owner')
  }
  return value
}

function validateTimestamp(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || value.includes('\0')) {
    throw new SqliteJobRepositoryError('JOB_INVALID_INPUT', `Invalid ${label}`)
  }
  return value
}

function validateInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SqliteJobRepositoryError('JOB_INVALID_INPUT', `Invalid ${label}`)
  }
  return value
}

function validateAttempts(value: number): number {
  return validateInteger(value, 1, 100, 'max attempts')
}

function serializeJobJson(value: JsonObject, label: string): string {
  const serialized = serializeJson(value, MAX_JOB_JSON_BYTES, label)
  if (serialized === undefined) throw new SqliteJobRepositoryError('JOB_INVALID_INPUT', `Invalid ${label}`)
  return serialized
}

function serializeEventDetail(value: JsonObject): string {
  const serialized = serializeJson(value, MAX_EVENT_DETAIL_BYTES, 'event detail')
  if (serialized === undefined) throw new SqliteJobRepositoryError('JOB_INVALID_INPUT', 'Invalid event detail')
  return serialized
}

function serializeJson(value: JsonObject, maxBytes: number, label: string): string | undefined {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > maxBytes) {
      throw new SqliteJobRepositoryError('JOB_INVALID_INPUT', `${label} is too large`)
    }
    return serialized
  } catch (error) {
    if (error instanceof SqliteJobRepositoryError) throw error
    throw new SqliteJobRepositoryError('JOB_INVALID_INPUT', `Invalid ${label}`)
  }
}

function parseJsonObject(value: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required')
    return parsed as JsonObject
  } catch {
    throw new SqliteJobRepositoryError('JOB_DATA_INVALID', 'Stored job data is invalid')
  }
}

function sanitizeErrorCode(value: string): string {
  if (typeof value !== 'string') return 'JOB_FAILED'
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/gu, '_').slice(0, 128)
  return normalized || 'JOB_FAILED'
}

function sanitizeErrorMessage(value: string): string {
  const raw = typeof value === 'string' ? value : 'Job failed'
  return raw
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu, '[REDACTED]')
    .replace(/\b(?:api[-_ ]?key|token|secret|password)\b\s*[:=]\s*[^\s,;]+/giu, '[REDACTED]')
    .replace(/([?&](?:token|api[-_]?key|key|signature)=)[^&\s]+/giu, '$1[REDACTED]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+/gu, '[path]')
    .replace(/(^|[\s('"`])\/(?:[^\s/'"`]+\/)+[^\s)'"`,;]*/gu, '$1[path]')
    .slice(0, MAX_ERROR_MESSAGE_BYTES)
}

function sanitizeDetail(detail: JsonObject, extra: JsonObject = {}): JsonObject {
  return { ...detail, ...extra }
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique|foreign key/iu.test(error.message)
}

function leaseLost(): SqliteJobRepositoryError {
  return new SqliteJobRepositoryError('JOB_LEASE_LOST', 'Job lease is no longer owned', true)
}
