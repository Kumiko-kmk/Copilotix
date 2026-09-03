import { describe, expect, it } from 'vitest'
import type { Job, JobCheckpoint } from '@core/jobs'
import { ProgressReporter } from '../src/main/progressReporter'

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
