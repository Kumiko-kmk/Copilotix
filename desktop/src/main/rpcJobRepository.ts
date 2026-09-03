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
import type { Job, JobEvent } from '@core/types'
import type { UtilitySupervisor } from './utilitySupervisor'

/** Main-side async facade for the utility-owned durable job repository. */
export class RpcJobRepository implements JobRepositoryPort {
  constructor(private readonly supervisor: UtilitySupervisor) {}

  async enqueue(input: JobEnqueueInput): Promise<Job> {
    return this.supervisor.request('jobs:enqueue', input)
  }

  async get(id: string): Promise<Job | null> {
    return this.supervisor.request('jobs:get', { id })
  }

  async list(query: JobListQuery = {}): Promise<Job[]> {
    const { statuses, ...rest } = query
    const payload = statuses ? { ...rest, statuses: [...statuses] } : rest
    return this.supervisor.request('jobs:list', payload)
  }

  async claimBatch(input: { now: string; leaseOwner: string; leaseExpiresAt: string; limit?: number; kind?: 'parse' | 'translate' }): Promise<Job[]> {
    return this.supervisor.request('jobs:claim-batch', input)
  }

  async heartbeat(input: JobHeartbeatInput): Promise<Job> {
    return this.supervisor.request('jobs:heartbeat', input)
  }

  async updateProgressAndCheckpoint(input: JobProgressCheckpointInput): Promise<Job> {
    return this.supervisor.request('jobs:update-progress', input)
  }

  async complete(input: JobCompleteInput): Promise<Job> {
    return this.supervisor.request('jobs:complete', input)
  }

  async failOrRetry(input: JobFailOrRetryInput): Promise<Job> {
    return this.supervisor.request('jobs:fail-or-retry', input)
  }

  async cancel(input: JobCancelInput): Promise<Job> {
    return this.supervisor.request('jobs:cancel', input)
  }

  async manualRetry(input: JobManualRetryInput): Promise<Job> {
    return this.supervisor.request('jobs:manual-retry', input)
  }

  async recoverExpired(input: JobRecoverExpiredInput): Promise<Job[]> {
    return this.supervisor.request('jobs:recover-expired', input)
  }

  async listEvents(jobId: string): Promise<JobEvent[]> {
    return this.supervisor.request('jobs:list-events', { jobId })
  }
}
