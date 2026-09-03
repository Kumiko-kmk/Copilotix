import { describe, expect, it } from 'vitest'
import { createUtilityOperationHandlers } from '../src/utility/core/utilityOperations'

describe('utility persistence lifecycle', () => {
  it('serializes a flush before close', async () => {
    const calls: string[] = []
    const state = {
      database: {
        connection: { exec: (sql: string) => { calls.push(sql) } },
        close: () => { calls.push('close') }
      }
    } as never
    const persistence = createUtilityOperationHandlers(state)
    const signal = new AbortController().signal
    const flush = persistence.handlers['database:flush']!({} as never, signal)
    const close = persistence.close()

    await Promise.all([flush, close])
    expect(calls).toEqual(['PRAGMA wal_checkpoint(PASSIVE)', 'close'])
  })
})
