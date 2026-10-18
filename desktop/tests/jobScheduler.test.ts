import { describe, expect, it } from 'vitest'
import { type JobRepositoryPort, type JobCheckpoint } from '../src/core/jobs'
import { type Job } from '../src/core/types'
import { JobScheduler } from '../src/main/jobScheduler'
import { createCoalescedRefresh } from '../src/main/coalescedRefresh'
import { ProgressReporter } from '../src/main/progressReporter'

describe("jobScheduler", () => {
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

  function queuedJob(kind: Job['kind'], id: string): Job {
    return {
      ...runningJob(),
      id,
      kind,
      status: 'queued',
      leaseOwner: null,
      leaseExpiresAt: null,
      startedAt: null
    }
  }

  function deferredRunner(onStart?: () => void): { runner: { run: ({ signal }: { signal: AbortSignal }) => Promise<{ status: 'succeeded' }> }; release: () => void } {
    let release!: () => void
    const result = new Promise<{ status: 'succeeded' }>((resolve) => { release = () => resolve({ status: 'succeeded' }) })
    return {
      runner: {
        run: async ({ signal }) => {
          onStart?.()
          if (signal.aborted) return { status: 'succeeded' }
          return result
        }
      },
      release
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

    it('does not claim queued RAG work when no corresponding runner is registered', async () => {
      const claimKinds: Job['kind'][] = []
      const repository = repositoryWith({
        recoverExpired: () => [],
        claimBatch: ({ kind }) => {
          if (kind) claimKinds.push(kind)
          return []
        }
      })
      const scheduler = new JobScheduler(repository, { now: () => now })

      await scheduler.start()

      expect(claimKinds).toEqual([])
      await scheduler.shutdown()
    })

    it('claims foreground work before low-priority RAG lanes', async () => {
      const claimKinds: Job['kind'][] = []
      const parse = queuedJob('parse', 'parse-1')
      const rag = queuedJob('rag-content-index', 'rag-content-1')
      const parseDeferred = deferredRunner()
      const ragDeferred = deferredRunner()
      const repository = repositoryWith({
        recoverExpired: () => [],
        claimBatch: ({ kind }) => {
          if (!kind) return []
          claimKinds.push(kind)
          if (kind === 'parse') return [parse]
          if (kind === 'rag-content-index') return [rag]
          return []
        },
        complete: (input) => ({ ...runningJob(), id: input.jobId, kind: input.jobId === parse.id ? 'parse' : rag.kind, status: input.status }),
        heartbeat: (input) => ({ ...runningJob(), id: input.jobId, kind: input.jobId === parse.id ? 'parse' : rag.kind })
      })
      const scheduler = new JobScheduler(repository, {
        leaseOwner: 'scheduler-test',
        parseAggregationWindowMs: 0,
        pollIntervalMs: 60_000,
        runners: { parse: parseDeferred.runner, 'rag-content-index': ragDeferred.runner }
      })

      await scheduler.start()
      expect(claimKinds).toEqual(['parse', 'rag-content-index'])

      parseDeferred.release()
      ragDeferred.release()
      await scheduler.shutdown()
    })

    it('isolates RAG lane concurrency and keeps deletion independently runnable', async () => {
      const queues: Record<Job['kind'], Job[]> = {
        parse: [],
        translate: [],
        'rag-content-index': [queuedJob('rag-content-index', 'content-1'), queuedJob('rag-content-index', 'content-2')],
        'rag-embed': [queuedJob('rag-embed', 'embed-1')],
        'rag-delete': [queuedJob('rag-delete', 'delete-1')]
      }
      const claimed: Job['kind'][] = []
      const started: Job['kind'][] = []
      const runners = {
        'rag-content-index': deferredRunner(() => started.push('rag-content-index')),
        'rag-embed': deferredRunner(() => started.push('rag-embed')),
        'rag-delete': deferredRunner(() => started.push('rag-delete'))
      }
      const repository = repositoryWith({
        recoverExpired: () => [],
        claimBatch: ({ kind }) => {
          if (!kind) return []
          claimed.push(kind)
          const queue = queues[kind]
          const job = queue?.shift()
          return job ? [job] : []
        }
      })
      const scheduler = new JobScheduler(repository, {
        leaseOwner: 'scheduler-test',
        parseAggregationWindowMs: 0,
        pollIntervalMs: 60_000,
        concurrency: { ragContent: 1, ragEmbed: 1, ragDelete: 1 },
        runners: {
          'rag-content-index': runners['rag-content-index'].runner,
          'rag-embed': runners['rag-embed'].runner,
          'rag-delete': runners['rag-delete'].runner
        }
      })

      await scheduler.start()
      expect(started.sort()).toEqual(['rag-content-index', 'rag-delete', 'rag-embed'])
      expect(claimed.filter((kind) => kind === 'rag-content-index')).toHaveLength(1)
      expect(scheduler.getActiveCount()).toBe(3)

      runners['rag-content-index'].release()
      runners['rag-embed'].release()
      runners['rag-delete'].release()
      await scheduler.shutdown()
    })
  })
})

describe("coalescedRefresh", () => {
  describe('coalesced document refresh', () => {
    it('collapses a burst into one running and one trailing refresh', async () => {
      const releases: Array<() => void> = []
      let runs = 0
      const trigger = createCoalescedRefresh(async () => {
        runs += 1
        await new Promise<void>((resolve) => releases.push(resolve))
      }, () => undefined, { minIntervalMs: 0 })

      for (let index = 0; index < 50; index += 1) trigger()
      expect(runs).toBe(1)
      releases.shift()!()
      await flush()
      expect(runs).toBe(2)
      releases.shift()!()
      await flush()
      expect(runs).toBe(2)

      trigger()
      expect(runs).toBe(3)
      releases.shift()!()
      await flush()
    })

    it('spaces refresh starts and keeps running after a failure', async () => {
      let clock = 0
      const timers: Array<{ at: number; callback: () => void }> = []
      const errors: unknown[] = []
      let runs = 0
      const trigger = createCoalescedRefresh(async () => {
        runs += 1
        if (runs === 1) throw new Error('utility restarting')
      }, (error) => errors.push(error), {
        minIntervalMs: 100,
        now: () => clock,
        setTimeout: (callback, delayMs) => { timers.push({ at: clock + delayMs, callback }) }
      })

      trigger()
      await flush()
      expect(errors).toHaveLength(1)
      trigger()
      trigger()
      expect(runs).toBe(1)
      expect(timers.map((timer) => timer.at)).toEqual([100])
      clock = 100
      timers.shift()!.callback()
      await flush()
      expect(runs).toBe(2)
    })
  })

  async function flush(): Promise<void> {
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
  }
})

describe("progressReporter", () => {
  describe('ProgressReporter', () => {
    it('requires both a meaningful delta and the minimum interval between ordinary updates', async () => {
      let clock = 0
      const updates: number[] = []
      const reporter = new ProgressReporter(async (progress) => {
        updates.push(progress)
        return {} as Job
      }, { now: () => clock })
      const checkpoint: JobCheckpoint = { stage: 'polling' }

      await reporter.report(1, checkpoint)
      clock = 100
      await reporter.report(2, checkpoint)
      clock = 250
      await reporter.report(2, checkpoint)
      clock = 300
      await reporter.report(2, { stage: 'result-ready' })

      expect(updates).toEqual([1, 2, 2])
    })
  })
})
