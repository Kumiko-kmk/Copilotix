/** Row mapping, validation and sanitizing for the SQLite job repository. */
import { JOB_MANUAL_RETRY_TRANSITIONS, JOB_STATUS_TRANSITIONS } from '../core/jobs'
import type { Job, JobEvent, JobKind, JobStatus, JsonObject } from '../core/jobs'

export const MAX_JOB_JSON_BYTES = 64 * 1024
export const MAX_ERROR_MESSAGE_BYTES = 4 * 1024
export const MAX_EVENT_DETAIL_BYTES = 16 * 1024

export type JobRow = {
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

export type EventRow = {
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

export function fromJobRow(row: JobRow): Job {
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

export function fromEventRow(row: EventRow): JobEvent {
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

export function assertTransition(from: JobStatus | null, to: JobStatus, manual = false, recovery = false): void {
  if (from === to) return
  if (recovery && from === 'running' && to === 'queued') return
  if (from === 'partial' || from === 'failed' || from === 'cancelled') {
    if (manual && JOB_MANUAL_RETRY_TRANSITIONS[from] === to) return
  } else if (from === null && to === 'queued') {
    return
  } else if (from !== null && JOB_STATUS_TRANSITIONS[from].includes(to)) {
    return
  }
  throw new SqliteJobRepositoryError('JOB_INVALID_TRANSITION', 'Job state transition is not allowed')
}

export function validateKind(kind: JobKind): JobKind {
  if (
    kind !== 'parse' &&
    kind !== 'translate' &&
    kind !== 'rag-content-index' &&
    kind !== 'rag-embed' &&
    kind !== 'rag-delete'
  ) throw new SqliteJobRepositoryError('JOB_INVALID_KIND', 'Job kind is not supported')
  return kind
}

export function validateStatus(status: JobStatus): JobStatus {
  if (!['queued', 'running', 'retry-wait', 'succeeded', 'partial', 'failed', 'cancelled'].includes(status)) {
    throw new SqliteJobRepositoryError('JOB_INVALID_STATUS', 'Job status is not supported')
  }
  return status
}

export function validateIdentifier(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\0')) {
    throw new SqliteJobRepositoryError('JOB_INVALID_INPUT', `Invalid ${label}`)
  }
  return value
}

export function validateLeaseOwner(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes('\0')) {
    throw new SqliteJobRepositoryError('JOB_INVALID_INPUT', 'Invalid lease owner')
  }
  return value
}

export function validateTimestamp(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || value.includes('\0')) {
    throw new SqliteJobRepositoryError('JOB_INVALID_INPUT', `Invalid ${label}`)
  }
  return value
}

export function validateInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SqliteJobRepositoryError('JOB_INVALID_INPUT', `Invalid ${label}`)
  }
  return value
}

export function validateAttempts(value: number): number {
  return validateInteger(value, 1, 100, 'max attempts')
}

export function serializeJobJson(value: JsonObject, label: string): string {
  const serialized = serializeJson(value, MAX_JOB_JSON_BYTES, label)
  if (serialized === undefined) throw new SqliteJobRepositoryError('JOB_INVALID_INPUT', `Invalid ${label}`)
  return serialized
}

export function serializeEventDetail(value: JsonObject): string {
  const serialized = serializeJson(value, MAX_EVENT_DETAIL_BYTES, 'event detail')
  if (serialized === undefined) throw new SqliteJobRepositoryError('JOB_INVALID_INPUT', 'Invalid event detail')
  return serialized
}

export function serializeJson(value: JsonObject, maxBytes: number, label: string): string | undefined {
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

export function parseJsonObject(value: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required')
    return parsed as JsonObject
  } catch {
    throw new SqliteJobRepositoryError('JOB_DATA_INVALID', 'Stored job data is invalid')
  }
}

export function sanitizeErrorCode(value: string): string {
  if (typeof value !== 'string') return 'JOB_FAILED'
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/gu, '_').slice(0, 128)
  return normalized || 'JOB_FAILED'
}

export function sanitizeErrorMessage(value: string): string {
  const raw = typeof value === 'string' ? value : 'Job failed'
  return raw
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu, '[REDACTED]')
    .replace(/\b(?:api[-_ ]?key|token|secret|password)\b\s*[:=]\s*[^\s,;]+/giu, '[REDACTED]')
    .replace(/([?&](?:token|api[-_]?key|key|signature)=)[^&\s]+/giu, '$1[REDACTED]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+/gu, '[path]')
    .replace(/(^|[\s('"`])\/(?:[^\s/'"`]+\/)+[^\s)'"`,;]*/gu, '$1[path]')
    .slice(0, MAX_ERROR_MESSAGE_BYTES)
}

export function sanitizeDetail(detail: JsonObject, extra: JsonObject = {}): JsonObject {
  return { ...detail, ...extra }
}

export function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique|foreign key/iu.test(error.message)
}

export function leaseLost(): SqliteJobRepositoryError {
  return new SqliteJobRepositoryError('JOB_LEASE_LOST', 'Job lease is no longer owned', true)
}
