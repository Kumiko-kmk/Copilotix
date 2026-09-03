import { randomUUID } from 'node:crypto'
import type {
  JobCheckpoint,
  JobRepositoryPort,
  JobRunner,
  JobRunnerRegistry,
  JobRunnerResult
} from '@core/jobs'
import type { Job, JobKind } from '@core/types'

export const JOB_LEASE_DURATION_MS = 30_000
export const JOB_HEARTBEAT_INTERVAL_MS = 10_000
export const JOB_PARSE_AGGREGATION_WINDOW_MS = 250
export const JOB_CLAIM_LIMIT = 50
export const JOB_MAX_BACKOFF_ATTEMPTS = 5

export interface SchedulerConcurrencyConfig {
  parse: number
  upload: number
  normalize: number
  translate: number
}

export const DEFAULT_SCHEDULER_CONCURRENCY: Readonly<SchedulerConcurrencyConfig> = Object.freeze({
  parse: 2,
  upload: 3,
  normalize: 2,
  translate: 2
})

export interface SchedulerBackoffOptions {
  baseMs?: number
  maxMs?: number
  random?: () => number
}

export interface JobSchedulerOptions {
  leaseOwner?: string
  pollIntervalMs?: number
  parseAggregationWindowMs?: number
  leaseDurationMs?: number
  heartbeatIntervalMs?: number
  claimLimit?: number
  concurrency?: Partial<SchedulerConcurrencyConfig>
  backoff?: SchedulerBackoffOptions
  runners?: JobRunnerRegistry
  now?: () => string
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
}

export type JobSchedulerState = 'idle' | 'running' | 'stopping' | 'stopped'

interface ActiveJob {
  job: Job
  runner: JobRunner
  controller: AbortController
  semaphore: AsyncSemaphore
  done: Promise<void>
}

/** Small FIFO semaphore used to make scheduler concurrency limits testable. */
export class AsyncSemaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Semaphore limit must be positive')
  }

  get activeCount(): number {
    return this.active
  }

  get availableCount(): number {
    return Math.max(0, this.limit - this.active)
  }

  tryAcquire(): boolean {
    if (this.active >= this.limit) return false
    this.active += 1
    return true
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.tryAcquire()) return () => this.release()
    if (signal?.aborted) throw new Error('Semaphore acquisition cancelled')
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const waiter = (): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        if (settled) return
        settled = true
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error('Semaphore acquisition cancelled'))
      }
      this.waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    this.active += 1
    return () => this.release()
  }

  release(): void {
    if (this.active <= 0) return
    this.active -= 1
    const next = this.waiters.shift()
    next?.()
  }
}

/**
 * Durable scheduler foundation. It intentionally claims work only for kinds
 * with a registered runner; 3B2 will register the real parse/translate work.
 */
export class JobScheduler {
  private readonly repository: JobRepositoryPort
  private readonly leaseOwner: string
  private readonly pollIntervalMs: number
  private readonly parseAggregationWindowMs: number
  private readonly leaseDurationMs: number
  private readonly heartbeatIntervalMs: number
  private readonly claimLimit: number
  private readonly concurrency: SchedulerConcurrencyConfig
  private readonly backoff: SchedulerBackoffOptions
  private readonly now: () => string
  private readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  private readonly cancelSchedule: (handle: ReturnType<typeof setTimeout>) => void
  private readonly runners: JobRunnerRegistry
  private readonly semaphores: Record<'parse' | 'translate', AsyncSemaphore>
  private readonly active = new Map<string, ActiveJob>()
  private state: JobSchedulerState = 'idle'
  private controller: AbortController | undefined
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined
  private pollInFlight: Promise<void> | undefined

  constructor(repository: JobRepositoryPort, options: JobSchedulerOptions = {}) {
    this.repository = repository
    this.leaseOwner = validateLeaseOwner(options.leaseOwner ?? `scheduler-${randomUUID()}`)
    this.pollIntervalMs = positiveInt(options.pollIntervalMs ?? 1_000, 1_000)
    this.parseAggregationWindowMs = nonNegativeInt(options.parseAggregationWindowMs ?? JOB_PARSE_AGGREGATION_WINDOW_MS)
    this.leaseDurationMs = positiveInt(options.leaseDurationMs ?? JOB_LEASE_DURATION_MS, JOB_LEASE_DURATION_MS)
    this.heartbeatIntervalMs = positiveInt(options.heartbeatIntervalMs ?? JOB_HEARTBEAT_INTERVAL_MS, JOB_HEARTBEAT_INTERVAL_MS)
    this.claimLimit = Math.min(JOB_CLAIM_LIMIT, positiveInt(options.claimLimit ?? JOB_CLAIM_LIMIT, JOB_CLAIM_LIMIT))
    this.concurrency = {
      parse: positiveInt(options.concurrency?.parse ?? DEFAULT_SCHEDULER_CONCURRENCY.parse, DEFAULT_SCHEDULER_CONCURRENCY.parse),
      upload: positiveInt(options.concurrency?.upload ?? DEFAULT_SCHEDULER_CONCURRENCY.upload, DEFAULT_SCHEDULER_CONCURRENCY.upload),
      normalize: positiveInt(options.concurrency?.normalize ?? DEFAULT_SCHEDULER_CONCURRENCY.normalize, DEFAULT_SCHEDULER_CONCURRENCY.normalize),
      translate: positiveInt(options.concurrency?.translate ?? DEFAULT_SCHEDULER_CONCURRENCY.translate, DEFAULT_SCHEDULER_CONCURRENCY.translate)
    }
    this.backoff = options.backoff ?? {}
    this.now = options.now ?? (() => new Date().toISOString())
    this.schedule = options.setTimeout ?? setTimeout
    this.cancelSchedule = options.clearTimeout ?? clearTimeout
    this.runners = { ...(options.runners ?? {}) }
    this.semaphores = {
      parse: new AsyncSemaphore(this.concurrency.parse),
      translate: new AsyncSemaphore(this.concurrency.translate)
    }
  }

  getState(): JobSchedulerState {
    return this.state
  }

  getActiveCount(): number {
    return this.active.size
  }

  getLeaseOwner(): string {
    return this.leaseOwner
  }

  getConcurrency(): SchedulerConcurrencyConfig {
    return { ...this.concurrency }
  }

  registerRunner(kind: JobKind, runner: JobRunner): void {
    this.runners[kind] = runner
    if (this.state === 'running') {
      void this.pollOnce().catch(() => undefined)
      this.schedulePoll()
      this.scheduleHeartbeat()
    }
  }

  unregisterRunner(kind: JobKind): void {
    delete this.runners[kind]
  }

  async start(): Promise<void> {
    if (this.state === 'running') return
    if (this.state === 'stopping') throw new Error('Job scheduler is stopping')
    this.controller = new AbortController()
    this.state = 'running'
    await this.repository.recoverExpired({ now: this.now() })
    if (this.hasRunner()) {
      await this.pollOnce()
      this.schedulePoll()
      this.scheduleHeartbeat()
    }
  }

  async pollNow(): Promise<void> {
    if (this.state !== 'running' || !this.hasRunner()) return
    await this.pollOnce()
  }

  async cancel(jobId: string): Promise<void> {
    const active = this.active.get(jobId)
    if (!active) return
    active.controller.abort()
    try {
      await Promise.resolve(this.repository.cancel({ jobId, leaseOwner: this.leaseOwner, now: this.now() }))
    } catch {
      // The runner may have completed or lost its lease concurrently.
    }
    await active.done
  }

  async shutdown(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'idle') {
      this.state = 'stopped'
      return
    }
    if (this.state === 'stopping') return
    this.state = 'stopping'
    this.controller?.abort()
    this.cancelTimer('poll')
    this.cancelTimer('heartbeat')
    const active = [...this.active.values()]
    for (const entry of active) {
      entry.controller.abort()
    }
    // A normal process shutdown is not a user cancellation. Keep running
    // leases durable so the next scheduler start can recover them after expiry.
    await Promise.all(active.map((entry) => entry.done))
    this.state = 'stopped'
  }

  private hasRunner(): boolean {
    return Boolean(this.runners.parse || this.runners.translate)
  }

  private async pollOnce(): Promise<void> {
    if (this.state !== 'running' || this.pollInFlight) {
      if (this.pollInFlight) await this.pollInFlight
      return
    }
    const controller = this.controller
    if (!controller || controller.signal.aborted) return
    const run = Promise.all([
      this.runners.parse ? this.claimKind('parse', this.parseAggregationWindowMs, controller.signal) : Promise.resolve(),
      this.runners.translate ? this.claimKind('translate', 0, controller.signal) : Promise.resolve()
    ]).then(() => undefined)
    this.pollInFlight = run
    try {
      await run
    } finally {
      if (this.pollInFlight === run) this.pollInFlight = undefined
    }
  }

  private async claimKind(kind: JobKind, delayMs: number, signal: AbortSignal): Promise<void> {
    if (delayMs > 0) await delay(delayMs, signal, this.schedule, this.cancelSchedule)
    if (signal.aborted || this.state !== 'running') return
    const runner = this.runners[kind]
    if (!runner) return
    const semaphore = this.semaphores[kind]
    const available = semaphore.availableCount
    if (available <= 0) return
    const claimedAt = this.now()
    const jobs = await Promise.resolve(this.repository.claimBatch({
      now: claimedAt,
      leaseOwner: this.leaseOwner,
      leaseExpiresAt: addMilliseconds(claimedAt, this.leaseDurationMs),
      limit: Math.min(this.claimLimit, available, JOB_CLAIM_LIMIT),
      kind
    }))
    for (const job of jobs) {
      if (signal.aborted || !semaphore.tryAcquire()) break
      this.startJob(job, runner, semaphore)
    }
  }

  private startJob(job: Job, runner: JobRunner, semaphore: AsyncSemaphore): void {
    const controller = new AbortController()
    const entry = {
      job,
      runner,
      controller,
      semaphore,
      done: Promise.resolve()
    } as ActiveJob
    entry.done = this.executeJob(entry)
      .catch(() => undefined)
      .finally(() => {
        this.active.delete(job.id)
        semaphore.release()
      })
    this.active.set(job.id, entry)
  }

  private async executeJob(entry: ActiveJob): Promise<void> {
    const { runner, controller } = entry
    try {
      const result = await runner.run({
        job: entry.job,
        signal: controller.signal,
        updateProgress: async (progress: number, checkpoint: JobCheckpoint): Promise<Job> => {
          entry.job = await Promise.resolve(this.repository.updateProgressAndCheckpoint({
            jobId: entry.job.id,
            leaseOwner: this.leaseOwner,
            progress,
            checkpoint,
            now: this.now()
          }))
          return entry.job
        }
      })
      if (controller.signal.aborted) return
      const normalized = normalizeRunnerResult(result, entry.job)
      entry.job = await Promise.resolve(this.repository.complete({
        jobId: entry.job.id,
        leaseOwner: this.leaseOwner,
        status: normalized.status,
        progress: normalized.progress,
        checkpoint: normalized.checkpoint,
        now: this.now(),
        detail: normalized.detail
      }))
    } catch (error) {
      if (controller.signal.aborted) return
      const attempt = entry.job.attempt
      const delayMs = fullJitterExponentialBackoff(attempt, this.backoff)
      await Promise.resolve(this.repository.failOrRetry({
        jobId: entry.job.id,
        leaseOwner: this.leaseOwner,
        errorCode: sanitizeErrorCode(error),
        errorMessage: sanitizeErrorMessage(error),
        availableAt: addMilliseconds(this.now(), delayMs),
        now: this.now()
      }))
    }
  }

  private schedulePoll(): void {
    if (this.pollTimer !== undefined || this.state !== 'running') return
    this.pollTimer = this.schedule(() => {
      this.pollTimer = undefined
      void this.pollOnce().catch(() => undefined).finally(() => this.schedulePoll())
    }, this.pollIntervalMs)
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeatTimer !== undefined || this.state !== 'running') return
    this.heartbeatTimer = this.schedule(() => {
      this.heartbeatTimer = undefined
      void this.heartbeat().catch(() => undefined).finally(() => this.scheduleHeartbeat())
    }, this.heartbeatIntervalMs)
  }

  private async heartbeat(): Promise<void> {
    if (this.state !== 'running') return
    const jobs = [...this.active.values()]
    await Promise.all(jobs.map(async (entry) => {
      if (entry.controller.signal.aborted) return
      try {
        const heartbeatAt = this.now()
        entry.job = await Promise.resolve(this.repository.heartbeat({
          jobId: entry.job.id,
          leaseOwner: this.leaseOwner,
          leaseExpiresAt: addMilliseconds(heartbeatAt, this.leaseDurationMs),
          now: heartbeatAt
        }))
      } catch {
        entry.controller.abort()
      }
    }))
  }

  private cancelTimer(kind: 'poll' | 'heartbeat'): void {
    const timer = kind === 'poll' ? this.pollTimer : this.heartbeatTimer
    if (timer === undefined) return
    this.cancelSchedule(timer)
    if (kind === 'poll') this.pollTimer = undefined
    else this.heartbeatTimer = undefined
  }
}

export function fullJitterExponentialBackoff(attempt: number, options: SchedulerBackoffOptions = {}): number {
  const baseMs = positiveInt(options.baseMs ?? 1_000, 1_000)
  const maxMs = Math.max(baseMs, positiveInt(options.maxMs ?? 60_000, 60_000))
  const random = options.random ?? Math.random
  const normalizedAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1
  const exponent = Math.min(JOB_MAX_BACKOFF_ATTEMPTS - 1, normalizedAttempt - 1)
  const cap = Math.min(maxMs, baseMs * (2 ** exponent))
  let sample = 0
  try {
    sample = random()
  } catch {
    sample = 0
  }
  if (!Number.isFinite(sample)) sample = 0
  return Math.floor(Math.max(0, Math.min(1, sample)) * cap)
}

function normalizeRunnerResult(result: JobRunnerResult, job: Job): JobRunnerResult {
  if (!result || (result.status !== 'succeeded' && result.status !== 'partial')) {
    throw new Error('Job runner returned an invalid result')
  }
  return {
    status: result.status,
    progress: result.progress ?? (result.status === 'succeeded' ? 100 : job.progress),
    checkpoint: result.checkpoint ?? job.checkpoint,
    detail: result.detail
  }
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) return timestamp
  return new Date(parsed + Math.max(0, milliseconds)).toISOString()
}

function delay(
  milliseconds: number,
  signal: AbortSignal,
  schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>,
  cancelSchedule: (handle: ReturnType<typeof setTimeout>) => void
): Promise<void> {
  if (milliseconds <= 0 || signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    const timer = schedule(() => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cancelSchedule(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function validateLeaseOwner(value: string): string {
  if (value.length === 0 || value.length > 256 || value.includes('\0')) throw new Error('Invalid scheduler lease owner')
  return value
}

function positiveInt(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function nonNegativeInt(value: number): number {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function sanitizeErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.name : 'JOB_RUNNER_FAILED'
  return raw.replace(/[^A-Za-z0-9_.:-]/gu, '_').slice(0, 128) || 'JOB_RUNNER_FAILED'
}

function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Job runner failed'
  return raw
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu, '[REDACTED]')
    .replace(/\b(?:api[-_ ]?key|token|secret|password)\b\s*[:=]\s*[^\s,;]+/giu, '[REDACTED]')
    .replace(/([?&](?:token|api[-_]?key|key|signature)=)[^&\s]+/giu, '$1[REDACTED]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+/gu, '[path]')
    .replace(/(^|[\s('"`])\/(?:[^\s/'"`]+\/)+[^\s)'"`,;]*/gu, '$1[path]')
    .slice(0, 4_096)
}
