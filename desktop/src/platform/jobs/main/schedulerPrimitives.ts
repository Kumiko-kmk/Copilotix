/** Concurrency and timing primitives of the job scheduler. */

/** Small FIFO semaphore used to make scheduler concurrency limits testable. */
export class AsyncSemaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Semaphore limit must be positive')
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

export function addMilliseconds(timestamp: string, milliseconds: number): string {
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) return timestamp
  return new Date(parsed + Math.max(0, milliseconds)).toISOString()
}

export function delay(
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
