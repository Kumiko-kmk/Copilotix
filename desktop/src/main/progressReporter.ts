import type { Job, JobCheckpoint } from '@core/jobs'

export interface ProgressReporterOptions {
  now?: () => number
  minDelta?: number
  minIntervalMs?: number
  onEmit?: (job: Job) => void | Promise<void>
}

/** Shared progress throttling: terminal/stage changes always flush. */
export class ProgressReporter {
  private readonly now: () => number
  private readonly minDelta: number
  private readonly minIntervalMs: number
  private readonly onEmit?: (job: Job) => void | Promise<void>
  private lastProgress = -1
  private lastStage: unknown
  private lastFlushAt = 0
  private hasFlushed = false

  constructor(
    private readonly update: (progress: number, checkpoint: JobCheckpoint) => Promise<Job>,
    options: ProgressReporterOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.minDelta = options.minDelta ?? 1
    this.minIntervalMs = options.minIntervalMs ?? 250
    this.onEmit = options.onEmit
  }

  async report(progress: number, checkpoint: JobCheckpoint, force = false): Promise<Job | null> {
    const normalized = Math.max(0, Math.min(100, Math.round(progress)))
    const stage = checkpoint.stage
    const changedStage = stage !== this.lastStage
    const terminal = normalized >= 100
    const timestamp = this.now()
    const due = !this.hasFlushed ||
      (normalized - this.lastProgress >= this.minDelta && timestamp - this.lastFlushAt >= this.minIntervalMs)
    if (!force && !changedStage && !terminal && !due) return null
    const job = await this.update(normalized, checkpoint)
    this.lastProgress = normalized
    this.lastStage = stage
    this.lastFlushAt = timestamp
    this.hasFlushed = true
    await this.onEmit?.(job)
    return job
  }
}
