export interface CoalescedRefreshOptions {
  /** Minimum time between the starts of two refreshes. */
  minIntervalMs?: number
  now?: () => number
  setTimeout?: (callback: () => void, delayMs: number) => unknown
}

/**
 * Collapse bursts of triggers into at most one running and one trailing call.
 * Every trigger is guaranteed to be followed by a run that starts after it.
 */
export function createCoalescedRefresh(
  run: () => Promise<void>,
  onError: (error: unknown) => void,
  options: CoalescedRefreshOptions = {}
): () => void {
  const minIntervalMs = options.minIntervalMs ?? 150
  const now = options.now ?? Date.now
  const schedule = options.setTimeout ?? setTimeout
  let pending = false
  let running = false
  let waiting = false
  let lastStartedAt = Number.NEGATIVE_INFINITY

  const execute = (): void => {
    waiting = false
    pending = false
    running = true
    lastStartedAt = now()
    void run()
      .catch(onError)
      .finally(() => {
        running = false
        if (pending) start()
      })
  }

  const start = (): void => {
    const delayMs = lastStartedAt + minIntervalMs - now()
    if (delayMs <= 0) {
      execute()
      return
    }
    waiting = true
    schedule(execute, delayMs)
  }

  return () => {
    pending = true
    if (!running && !waiting) start()
  }
}
