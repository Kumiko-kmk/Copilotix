import type { RenderTask } from 'pdfjs-dist'

export interface ScheduledPdfRender {
  promise: Promise<void>
  cancel(): void
  setPriority(priority: number): void
}

interface RenderJob {
  resource: object
  priority: number
  sequence: number
  start(): Pick<RenderTask, 'promise' | 'cancel'>
  task: Pick<RenderTask, 'promise' | 'cancel'> | null
  cancelled: boolean
  settled: boolean
  resolve(): void
  reject(error: unknown): void
}

export class PdfRenderScheduler {
  private readonly queue: RenderJob[] = []
  private readonly activeResources = new WeakSet<object>()
  private activeCount = 0
  private sequence = 0
  private pumpQueued = false

  constructor(private readonly maxConcurrent = 2) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError('PDF render concurrency must be a positive integer')
    }
  }

  schedule(
    resource: object,
    priority: number,
    start: () => Pick<RenderTask, 'promise' | 'cancel'>
  ): ScheduledPdfRender {
    let resolvePromise!: () => void
    let rejectPromise!: (error: unknown) => void
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const job: RenderJob = {
      resource,
      priority: Number.isFinite(priority) ? priority : Number.MAX_SAFE_INTEGER,
      sequence: this.sequence++,
      start,
      task: null,
      cancelled: false,
      settled: false,
      resolve: resolvePromise,
      reject: rejectPromise
    }
    this.queue.push(job)
    this.schedulePump()
    return {
      promise,
      cancel: () => this.cancel(job),
      setPriority: (priority) => this.setPriority(job, priority)
    }
  }

  private setPriority(job: RenderJob, priority: number): void {
    if (job.cancelled || job.settled || job.task) return
    job.priority = Number.isFinite(priority) ? priority : Number.MAX_SAFE_INTEGER
    this.schedulePump()
  }

  private cancel(job: RenderJob): void {
    if (job.cancelled || job.settled) return
    job.cancelled = true
    if (job.task) {
      job.task.cancel()
      return
    }
    const index = this.queue.indexOf(job)
    if (index >= 0) this.queue.splice(index, 1)
    job.settled = true
    job.reject(new PdfRenderCancelledError())
  }

  private schedulePump(): void {
    if (this.pumpQueued) return
    this.pumpQueued = true
    queueMicrotask(() => {
      this.pumpQueued = false
      this.pump()
    })
  }

  private pump(): void {
    this.queue.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence)
    while (this.activeCount < this.maxConcurrent) {
      const index = this.queue.findIndex((job) => !job.cancelled && !this.activeResources.has(job.resource))
      if (index < 0) return
      const [job] = this.queue.splice(index, 1)
      if (!job) return
      this.start(job)
    }
  }

  private start(job: RenderJob): void {
    if (job.cancelled) return
    this.activeCount += 1
    this.activeResources.add(job.resource)
    try {
      job.task = job.start()
    } catch (error) {
      this.finish(job, error)
      return
    }
    void job.task.promise.then(
      () => this.finish(job),
      (error: unknown) => this.finish(job, error)
    )
  }

  private finish(job: RenderJob, error?: unknown): void {
    if (job.settled) return
    job.settled = true
    this.activeCount -= 1
    this.activeResources.delete(job.resource)
    if (error === undefined) job.resolve()
    else job.reject(error)
    this.schedulePump()
  }
}

export class PdfRenderCancelledError extends Error {
  constructor() {
    super('PDF render was cancelled before it started')
    this.name = 'RenderingCancelledException'
  }
}

export const pdfPageRenderScheduler = new PdfRenderScheduler(2)
