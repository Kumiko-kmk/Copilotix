import type { Job, JobEvent, JobKind, JobStatus, JsonObject } from './types'

export type { Job, JobEvent, JobKind, JobStatus, JsonObject } from './types'

/** State transitions accepted by the durable job state machine. */
export const JOB_STATUS_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = Object.freeze({
  queued: ['running'],
  running: ['succeeded', 'partial', 'retry-wait', 'failed', 'cancelled'],
  'retry-wait': ['queued'],
  succeeded: [],
  partial: [],
  failed: [],
  cancelled: []
})

export const JOB_MANUAL_RETRY_TRANSITIONS: Readonly<Record<'partial' | 'failed' | 'cancelled', 'queued'>> = Object.freeze({
  partial: 'queued',
  failed: 'queued',
  cancelled: 'queued'
})

export const JOB_TRANSITIONS = JOB_STATUS_TRANSITIONS

export const JOB_TERMINAL_STATES: ReadonlySet<JobStatus> = new Set(['succeeded', 'partial', 'failed', 'cancelled'])

export type JobCheckpoint = JsonObject
export type Checkpoint = JobCheckpoint

export interface JobEnqueueInput {
  id?: string
  documentId: string
  kind: JobKind
  dependsOnJobId?: string | null
  priority?: number
  maxAttempts?: number
  payload?: JsonObject
  checkpoint?: JobCheckpoint
  availableAt?: string
  now?: string
}

export interface JobClaimRequest {
  now: string
  leaseOwner: string
  leaseExpiresAt: string
  limit?: number
  kind?: JobKind
}

export interface JobClaim {
  job: Job
  leaseOwner: string
  leaseExpiresAt: string
}
export type Claim = JobClaim

export interface JobListQuery {
  documentId?: string
  kind?: JobKind
  statuses?: readonly JobStatus[]
  limit?: number
}

export interface JobHeartbeatInput {
  jobId: string
  leaseOwner: string
  leaseExpiresAt: string
  now?: string
}

export interface JobProgressCheckpointInput {
  jobId: string
  leaseOwner: string
  progress: number
  checkpoint: JobCheckpoint
  now?: string
}

export interface JobCompleteInput {
  jobId: string
  leaseOwner: string
  status: Extract<JobStatus, 'succeeded' | 'partial'>
  progress?: number
  checkpoint?: JobCheckpoint
  now?: string
  detail?: JsonObject
}

export interface JobFailOrRetryInput {
  jobId: string
  leaseOwner: string
  errorCode: string
  errorMessage: string
  availableAt?: string
  now?: string
  /** Permanent failures bypass retry-wait even when attempts remain. */
  terminal?: boolean
  detail?: JsonObject
}

export interface JobCancelInput {
  jobId: string
  leaseOwner: string
  now?: string
  detail?: JsonObject
}

export interface JobManualRetryInput {
  jobId: string
  now?: string
  availableAt?: string
  detail?: JsonObject
}

export interface JobRecoverExpiredInput {
  now: string
}

export interface JobTransition {
  jobId: string
  fromState: JobStatus | null
  toState: JobStatus
  detail: JsonObject
  createdAt: string
}
export type Transition = JobTransition

export function canTransition(fromState: JobStatus | null, toState: JobStatus, manual = false, recovery = false): boolean {
  if (fromState === toState) return true
  if (recovery && fromState === 'running' && toState === 'queued') return true
  if (fromState === null) return toState === 'queued'
  if (manual && (fromState === 'partial' || fromState === 'failed' || fromState === 'cancelled')) return toState === 'queued'
  return JOB_STATUS_TRANSITIONS[fromState].includes(toState)
}

export interface JobRunnerInput {
  job: Job
  signal: AbortSignal
  updateProgress: (progress: number, checkpoint: JobCheckpoint) => Promise<Job>
}

export interface JobRunnerResult {
  status: Extract<JobStatus, 'succeeded' | 'partial'>
  progress?: number
  checkpoint?: JobCheckpoint
  detail?: JsonObject
}

/** Runner failures carry a safe code and retry classification to the scheduler. */
export class JobRunnerError extends Error {
  constructor(
    message: string,
    readonly code = 'JOB_RUNNER_FAILED',
    readonly retryable = false
  ) {
    super(message)
    this.name = 'JobRunnerError'
  }
}

export interface JobRunner {
  run(input: JobRunnerInput): Promise<JobRunnerResult>
}

export interface JobBatchRunnerInput {
  jobs: Job[]
  signal: AbortSignal
  updateProgress: (jobId: string, progress: number, checkpoint: JobCheckpoint) => Promise<Job>
}

export interface JobBatchResult {
  jobId: string
  result?: JobRunnerResult
  error?: unknown
}

/** Optional batch entry point. A scheduler semaphore slot represents one batch. */
export interface BatchJobRunner extends JobRunner {
  runBatch(input: JobBatchRunnerInput): Promise<readonly JobBatchResult[]>
}

export type JobRunnerRegistry = Partial<Record<JobKind, JobRunner | BatchJobRunner>>

export type JobRepositoryResult<T> = T | Promise<T>

export interface JobRepositoryPort {
  enqueue(input: JobEnqueueInput): JobRepositoryResult<Job>
  get(id: string): JobRepositoryResult<Job | null>
  list(query?: JobListQuery): JobRepositoryResult<Job[]>
  claimBatch(input: JobClaimRequest): JobRepositoryResult<Job[]>
  heartbeat(input: JobHeartbeatInput): JobRepositoryResult<Job>
  updateProgressAndCheckpoint(input: JobProgressCheckpointInput): JobRepositoryResult<Job>
  complete(input: JobCompleteInput): JobRepositoryResult<Job>
  failOrRetry(input: JobFailOrRetryInput): JobRepositoryResult<Job>
  cancel(input: JobCancelInput): JobRepositoryResult<Job>
  manualRetry(input: JobManualRetryInput): JobRepositoryResult<Job>
  recoverExpired(input: JobRecoverExpiredInput): JobRepositoryResult<Job[]>
  listEvents(jobId: string): JobRepositoryResult<JobEvent[]>
}
