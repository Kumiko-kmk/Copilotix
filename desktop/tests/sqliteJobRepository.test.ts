import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JobRepositoryPort } from '@core/jobs'
import type { Job } from '@core/types'
import { JobScheduler } from '../src/main/jobScheduler'
import { V2Database } from '../src/utility/core/persistence/v2Database'
import { SqliteJobRepository } from '../src/utility/core/persistence/sqliteJobRepository'

const directories: string[] = []
const now = '2026-01-01T00:00:00.000Z'
const later = '2026-01-01T00:01:00.000Z'
const expiry = '2026-01-01T00:00:30.000Z'

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(documentIds = ['document-1']): Promise<{ database: V2Database; repository: SqliteJobRepository }> {
  const directory = await mkdtemp(join(tmpdir(), 'copilotix-jobs-'))
  directories.push(directory)
  const database = new V2Database(join(directory, 'jobs.sqlite3'))
  const insert = database.connection.prepare(`
    INSERT INTO documents(
      id,original_filename,display_title,storage_path,source_checksum,
      translation_provider,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?)
  `)
  for (const id of documentIds) {
    insert.run(id, `${id}.pdf`, null, `C:/documents/${id}`, `hash-${id}`, 'qwen', now, now)
  }
  return { database, repository: new SqliteJobRepository(database) }
}

function close(database: V2Database): void {
  database.close()
}

describe('SqliteJobRepository', () => {
  it('enforces one active job per document and kind', async () => {
    const { database, repository } = await fixture()
    try {
      repository.enqueue({ id: 'parse-1', documentId: 'document-1', kind: 'parse', now })
      expect(() => repository.enqueue({ id: 'parse-2', documentId: 'document-1', kind: 'parse', now })).toThrowError(
        expect.objectContaining({ code: 'JOB_ACTIVE_EXISTS' })
      )
      expect(repository.enqueue({ id: 'translate-1', documentId: 'document-1', kind: 'translate', now }).kind).toBe('translate')
    } finally {
      close(database)
    }
  })

  it('does not duplicate jobs across concurrent or continuous claims', async () => {
    const { database, repository } = await fixture(['document-1', 'document-2'])
    try {
      repository.enqueue({ id: 'parse-1', documentId: 'document-1', kind: 'parse', now })
      repository.enqueue({ id: 'parse-2', documentId: 'document-2', kind: 'parse', now })
      const [first, second] = await Promise.all([
        Promise.resolve(repository.claimBatch({ now, leaseOwner: 'worker-a', leaseExpiresAt: expiry, limit: 50, kind: 'parse' })),
        Promise.resolve(repository.claimBatch({ now, leaseOwner: 'worker-b', leaseExpiresAt: expiry, limit: 50, kind: 'parse' }))
      ])
      const claimed = [...first, ...second]
      expect(claimed.map((job) => job.id).sort()).toEqual(['parse-1', 'parse-2'])
      expect(new Set(claimed.map((job) => job.id)).size).toBe(2)
      expect(repository.claimBatch({ now, leaseOwner: 'worker-c', leaseExpiresAt: expiry, limit: 50, kind: 'parse' })).toEqual([])
      expect(repository.listEvents('parse-1').map((event) => event.sequence)).toEqual([1, 2])
    } finally {
      close(database)
    }
  })

  it('accepts heartbeat only from the current owner', async () => {
    const { database, repository } = await fixture()
    try {
      repository.enqueue({ id: 'parse-1', documentId: 'document-1', kind: 'parse', now })
      repository.claimBatch({ now, leaseOwner: 'worker-a', leaseExpiresAt: expiry, kind: 'parse' })
      expect(() => repository.heartbeat({ jobId: 'parse-1', leaseOwner: 'worker-b', leaseExpiresAt: later, now })).toThrowError(
        expect.objectContaining({ code: 'JOB_LEASE_LOST' })
      )
      expect(repository.heartbeat({ jobId: 'parse-1', leaseOwner: 'worker-a', leaseExpiresAt: later, now }).leaseExpiresAt).toBe(later)
    } finally {
      close(database)
    }
  })

  it('recovers only expired running leases and respects the retry limit', async () => {
    const { database, repository } = await fixture(['document-1', 'document-2'])
    try {
      repository.enqueue({ id: 'expired', documentId: 'document-1', kind: 'parse', maxAttempts: 2, now })
      repository.enqueue({ id: 'in-flight', documentId: 'document-2', kind: 'parse', maxAttempts: 1, now })
      repository.claimBatch({ now, leaseOwner: 'worker-a', leaseExpiresAt: '2025-12-31T23:59:00.000Z', kind: 'parse' })
      repository.claimBatch({ now, leaseOwner: 'worker-b', leaseExpiresAt: '2026-01-01T01:00:00.000Z', kind: 'parse' })
      const recovered = repository.recoverExpired({ now })
      expect(recovered).toHaveLength(1)
      expect(repository.get('expired')?.status).toBe('queued')
      expect(repository.get('in-flight')?.status).toBe('running')
      repository.claimBatch({ now, leaseOwner: 'worker-c', leaseExpiresAt: expiry, kind: 'parse' })
      expect(repository.recoverExpired({ now: later }).map((job) => job.status)).toEqual(['failed'])
      expect(repository.get('expired')?.errorCode).toBe('LEASE_EXPIRED')
    } finally {
      close(database)
    }
  })

  it('gates a dependent job until its dependency is succeeded or partial', async () => {
    const { database, repository } = await fixture()
    try {
      repository.enqueue({ id: 'parse-1', documentId: 'document-1', kind: 'parse', now })
      repository.enqueue({ id: 'translate-1', documentId: 'document-1', kind: 'translate', dependsOnJobId: 'parse-1', now })
      expect(repository.claimBatch({ now, leaseOwner: 'worker-a', leaseExpiresAt: expiry, kind: 'translate' })).toEqual([])
      repository.claimBatch({ now, leaseOwner: 'worker-a', leaseExpiresAt: expiry, kind: 'parse' })
      repository.complete({ jobId: 'parse-1', leaseOwner: 'worker-a', status: 'partial', now })
      expect(repository.claimBatch({ now, leaseOwner: 'worker-a', leaseExpiresAt: expiry, kind: 'translate' }).map((job) => job.id)).toEqual(['translate-1'])
    } finally {
      close(database)
    }
  })

  it('keeps checkpoint and event transitions idempotent while retrying with bounded backoff input', async () => {
    const { database, repository } = await fixture()
    try {
      repository.enqueue({ id: 'parse-1', documentId: 'document-1', kind: 'parse', maxAttempts: 2, now })
      repository.claimBatch({ now, leaseOwner: 'worker-a', leaseExpiresAt: expiry, kind: 'parse' })
      repository.updateProgressAndCheckpoint({ jobId: 'parse-1', leaseOwner: 'worker-a', progress: 42, checkpoint: { phase: 'uploading' }, now })
      expect(repository.get('parse-1')?.checkpoint).toEqual({ phase: 'uploading' })
      repository.failOrRetry({ jobId: 'parse-1', leaseOwner: 'worker-a', errorCode: 'REMOTE', errorMessage: 'temporary', availableAt: later, now })
      expect(repository.get('parse-1')?.status).toBe('retry-wait')
      repository.claimBatch({ now: later, leaseOwner: 'worker-a', leaseExpiresAt: expiry, kind: 'parse' })
      repository.failOrRetry({ jobId: 'parse-1', leaseOwner: 'worker-a', errorCode: 'REMOTE', errorMessage: 'temporary', availableAt: later, now: later })
      expect(repository.get('parse-1')?.status).toBe('failed')
      const eventCount = repository.listEvents('parse-1').length
      expect(repository.manualRetry({ jobId: 'parse-1', now: later }).status).toBe('queued')
      expect(repository.listEvents('parse-1')).toHaveLength(eventCount + 1)
      expect(() => repository.manualRetry({ jobId: 'parse-1', now: later })).toThrowError(
        expect.objectContaining({ code: 'JOB_RETRY_NOT_ALLOWED' })
      )
    } finally {
      close(database)
    }
  })

  it('requeues a partial job in place for manual resume', async () => {
    const { database, repository } = await fixture()
    try {
      repository.enqueue({ id: 'translate-1', documentId: 'document-1', kind: 'translate', now })
      repository.claimBatch({ now, leaseOwner: 'worker-a', leaseExpiresAt: expiry, kind: 'translate' })
      repository.complete({ jobId: 'translate-1', leaseOwner: 'worker-a', status: 'partial', progress: 100, checkpoint: { completedBlocks: 2 }, now })
      const retried = repository.manualRetry({ jobId: 'translate-1', now: later })
      expect(retried).toMatchObject({ id: 'translate-1', status: 'queued', attempt: 2, checkpoint: { completedBlocks: 2 } })
      expect(retried.errorCode).toBeNull()
    } finally {
      close(database)
    }
  })

  it('aborts active runners on shutdown without cancelling their durable lease', async () => {
    const job: Job = {
      id: 'parse-1', documentId: 'document-1', kind: 'parse', status: 'running', progress: 0,
      dependsOnJobId: null, priority: 0, attempt: 1, maxAttempts: 5, payload: {}, checkpoint: {},
      availableAt: now, leaseOwner: 'scheduler-test', leaseExpiresAt: expiry, errorCode: null, errorMessage: null,
      startedAt: now, finishedAt: null, createdAt: now, updatedAt: now
    }
    let cancelCalls = 0
    let runnerSignal!: AbortSignal
    let release!: () => void
    const running = new Promise<{ status: 'succeeded' }>((resolve) => { release = () => resolve({ status: 'succeeded' }) })
    const repository: JobRepositoryPort = {
      enqueue: () => job,
      get: () => job,
      list: () => [],
      claimBatch: () => [job],
      heartbeat: () => job,
      updateProgressAndCheckpoint: () => job,
      complete: () => job,
      failOrRetry: () => job,
      cancel: () => { cancelCalls += 1; return job },
      manualRetry: () => job,
      recoverExpired: () => [],
      listEvents: () => []
    }
    const scheduler = new JobScheduler(repository, {
      leaseOwner: 'scheduler-test',
      parseAggregationWindowMs: 0,
      pollIntervalMs: 60_000,
      runners: { parse: { run: async ({ signal }) => { runnerSignal = signal; return running } } }
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
})
