import { describe, expect, it, vi } from 'vitest'
import { PdfRenderScheduler } from '../src/renderer/pdfRenderScheduler'

interface DeferredTask {
  promise: Promise<void>
  cancel: ReturnType<typeof vi.fn>
  resolve(): void
  reject(error: unknown): void
}

describe('PdfRenderScheduler', () => {
  it('prioritizes the visible page and bounds concurrent rendering', async () => {
    const scheduler = new PdfRenderScheduler(2)
    const starts: string[] = []
    const tasks = new Map<string, DeferredTask>()
    const schedule = (name: string, priority: number) => scheduler.schedule({}, priority, () => {
      starts.push(name)
      const task = deferredTask()
      tasks.set(name, task)
      return task
    })

    const previous = schedule('previous', 1)
    const current = schedule('current', 0)
    const next = schedule('next', 1)
    await Promise.resolve()

    expect(starts).toEqual(['current', 'previous'])
    expect(tasks.has('next')).toBe(false)
    tasks.get('current')?.resolve()
    await current.promise
    await Promise.resolve()
    expect(starts).toEqual(['current', 'previous', 'next'])

    tasks.get('previous')?.resolve()
    tasks.get('next')?.resolve()
    await Promise.all([previous.promise, next.promise])
  })

  it('never renders the same canvas concurrently during a cancelled replacement', async () => {
    const scheduler = new PdfRenderScheduler(2)
    const canvas = {}
    const firstTask = deferredTask()
    const secondTask = deferredTask()
    const secondStart = vi.fn(() => secondTask)
    const first = scheduler.schedule(canvas, 0, () => firstTask)
    await Promise.resolve()
    const second = scheduler.schedule(canvas, 0, secondStart)
    await Promise.resolve()
    expect(secondStart).not.toHaveBeenCalled()

    first.cancel()
    expect(firstTask.cancel).toHaveBeenCalledOnce()
    firstTask.reject(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' }))
    await expect(first.promise).rejects.toMatchObject({ name: 'RenderingCancelledException' })
    await Promise.resolve()
    expect(secondStart).toHaveBeenCalledOnce()

    secondTask.resolve()
    await second.promise
  })

  it('cancels queued work without starting it', async () => {
    const scheduler = new PdfRenderScheduler(1)
    const activeTask = deferredTask()
    const active = scheduler.schedule({}, 0, () => activeTask)
    await Promise.resolve()
    const queuedStart = vi.fn(() => deferredTask())
    const queued = scheduler.schedule({}, 1, queuedStart)
    queued.cancel()
    await expect(queued.promise).rejects.toMatchObject({ name: 'RenderingCancelledException' })
    expect(queuedStart).not.toHaveBeenCalled()
    activeTask.resolve()
    await active.promise
  })

  it('reprioritizes queued pages without restarting active work', async () => {
    const scheduler = new PdfRenderScheduler(1)
    const blockerTask = deferredTask()
    const blocker = scheduler.schedule({}, 0, () => blockerTask)
    await Promise.resolve()
    const starts: string[] = []
    const firstTask = deferredTask()
    const secondTask = deferredTask()
    const first = scheduler.schedule({}, 1, () => {
      starts.push('first')
      return firstTask
    })
    const second = scheduler.schedule({}, 2, () => {
      starts.push('second')
      return secondTask
    })
    second.setPriority(0)

    blockerTask.resolve()
    await blocker.promise
    await Promise.resolve()
    expect(starts).toEqual(['second'])
    secondTask.resolve()
    await second.promise
    await Promise.resolve()
    expect(starts).toEqual(['second', 'first'])
    firstTask.resolve()
    await first.promise
  })
})

function deferredTask(): DeferredTask {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, cancel: vi.fn(), resolve, reject }
}
