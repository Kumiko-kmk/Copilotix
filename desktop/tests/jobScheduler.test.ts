import { describe, expect, it } from 'vitest'
import type { JobRepositoryPort } from '@core/jobs'
import type { Job } from '@core/types'
import { JobScheduler } from '../src/main/jobScheduler'

const now = '2026-01-01T00:00:00.000Z'

function unused<T>(): T {
  throw new Error('unused test repository operation')
}

function repositoryWith(overrides: Partial<JobRepositoryPort> = {}): JobRepositoryPort {
  return {
    enqueue: () => unused(),
    get: () => unused(),
    list: () => unused(),
    claimBatch: () => unused(),
    heartbeat: () => unused(),
    updateProgressAndCheckpoint: () => unused(),
    complete: () => unused(),
    failOrRetry: () => unused(),
    cancel: () => unused(),
    manualRetry: () => unused(),
    recoverExpired: () => unused(),
    listEvents: () => unused(),
    ...overrides
  }
}

function runningJob(): Job {
  return {
    id: 'parse-1',
    documentId: 'document-1',
    kind: 'parse',
    status: 'running',
    progress: 0,
    dependsOnJobId: null,
    priority: 0,
    attempt: 1,
    maxAttempts: 5,
    payload: {},
    checkpoint: {},
    availableAt: now,
    leaseOwner: 'scheduler-test',
    leaseExpiresAt: '2026-01-01T00:00:30.000Z',
    errorCode: null,
    errorMessage: null,
    startedAt: now,
    finishedAt: null,
    createdAt: now,
    updatedAt: now
  }
}

describe('JobScheduler lifecycle', () => {
  it('recovers expired leases on start without claiming when no runner is registered', async () => {
    let recoverCalls = 0
    let claimCalls = 0
    const repository = repositoryWith({
      recoverExpired: () => {
        recoverCalls += 1
        return []
      },
      claimBatch: () => {
        claimCalls += 1
        return []
      }
    })
    const scheduler = new JobScheduler(repository, { now: () => now })

    await scheduler.start()

    expect(recoverCalls).toBe(1)
    expect(claimCalls).toBe(0)
    await scheduler.shutdown()
  })

  it('aborts active runners on shutdown without cancelling the durable job', async () => {
    const job = runningJob()
    let cancelCalls = 0
    let runnerSignal!: AbortSignal
    let release!: () => void
    const runnerDone = new Promise<{ status: 'succeeded' }>((resolve) => {
      release = () => resolve({ status: 'succeeded' })
    })
    const repository = repositoryWith({
      recoverExpired: () => [],
      claimBatch: () => [job],
      cancel: () => {
        cancelCalls += 1
        return job
      }
    })
    const scheduler = new JobScheduler(repository, {
      leaseOwner: 'scheduler-test',
      parseAggregationWindowMs: 0,
      pollIntervalMs: 60_000,
      runners: {
        parse: {
          run: async ({ signal }) => {
            runnerSignal = signal
            return runnerDone
          }
        }
      }
    })

    await scheduler.start()
    expect(scheduler.getActiveCount()).toBe(1)

    const stopping = scheduler.shutdown()
    await Promise.resolve()
    expect(runnerSignal.aborted).toBe(true)
    release()
    await stopping

    expect(cancelCalls).toBe(0)
  })

  it('bounds shutdown drain when a runner ignores abort', async () => {
    const job = runningJob()
    let release!: () => void
    let runnerSignal!: AbortSignal
    const runnerDone = new Promise<{ status: 'succeeded' }>((resolve) => {
      release = () => resolve({ status: 'succeeded' })
    })
    let cancelCalls = 0
    const repository = repositoryWith({
      recoverExpired: () => [],
      claimBatch: () => [job],
      cancel: () => {
        cancelCalls += 1
        return job
      }
    })
    const scheduler = new JobScheduler(repository, {
      leaseOwner: 'scheduler-test',
      parseAggregationWindowMs: 0,
      pollIntervalMs: 60_000,
      shutdownDrainTimeoutMs: 5,
      runners: {
        parse: {
          run: async ({ signal }) => {
            runnerSignal = signal
            return runnerDone
          }
        }
      }
    })

    await scheduler.start()
    await scheduler.shutdown()

    expect(runnerSignal.aborted).toBe(true)
    expect(cancelCalls).toBe(0)
    release()
  })
})
