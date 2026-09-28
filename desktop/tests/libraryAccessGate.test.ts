import { describe, expect, it, vi } from 'vitest'
import { LibraryAccessGate } from '../src/main/libraryAccessGate'
import { acquirePrimaryInstance } from '../src/main/singleInstance'

describe('library operation isolation', () => {
  it('excludes in-flight UI operations and locks all data access until maintenance finishes', async () => {
    const gate = new LibraryAccessGate()
    let finish!: () => void
    const pending = gate.run('documents:import', () => new Promise<void>((resolve) => { finish = resolve }))
    await expect(gate.run('library:manage', () => undefined)).rejects.toThrow('尚未结束')
    finish()
    await pending
    const maintenance = gate.run('library:manage', () => new Promise<void>((resolve) => { finish = resolve }))
    await expect(gate.run('settings:save', () => undefined)).rejects.toThrow('维护')
    await expect(gate.run('library:manage', () => undefined)).rejects.toThrow('维护')
    await expect(gate.run('window:action', () => 'ok')).resolves.toBe('ok')
    finish()
    await maintenance
    await expect(gate.run('settings:save', () => 'ok')).resolves.toBe('ok')
  })
  it('keeps a restored library locked until restart and releases locks on failure', async () => {
    const gate = new LibraryAccessGate()
    await expect(gate.run('library:manage', () => { throw new Error('failure') })).rejects.toThrow('failure')
    expect(gate.busy).toBe(false)
    gate.requireRestart()
    await expect(gate.run('documents:import', () => undefined)).rejects.toThrow('维护')
  })
})

describe('single application instance', () => {
  it('quits a secondary instance before registering handlers', () => {
    const app = { requestSingleInstanceLock: () => false, on: vi.fn(), quit: vi.fn() }
    expect(acquirePrimaryInstance(app, () => null)).toBe(false)
    expect(app.quit).toHaveBeenCalledOnce()
    expect(app.on).not.toHaveBeenCalled()
  })
  it('restores and focuses the original window', () => {
    let second!: () => void
    const window = { isMinimized: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn() }
    const app = { requestSingleInstanceLock: () => true, on: (_: string, listener: () => void) => { second = listener }, quit: vi.fn() }
    expect(acquirePrimaryInstance(app, () => window)).toBe(true)
    second()
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })
})
