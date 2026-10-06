import { describe, expect, it } from 'vitest'
import { createCoalescedRefresh } from '@main/coalescedRefresh'

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
