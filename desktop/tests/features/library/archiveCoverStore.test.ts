import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredArchiveCover } from '../../../src/features/library/renderer/archive/archiveCoverStore'

type Request = { result?: unknown; error?: unknown; onsuccess?: () => void; onerror?: () => void }
const rows = new Map<string, StoredArchiveCover>()

/** Just enough IndexedDB for the cover store: get/put/delete and the LRU cursor, completing asynchronously. */
function fakeIndexedDB() {
  const request = (run: (request: Request) => unknown): Request => {
    const value: Request = {}
    queueMicrotask(() => { value.result = run(value); value.onsuccess?.() })
    return value
  }
  const store = {
    get: (key: string) => request(() => rows.get(key)),
    put: (record: StoredArchiveCover) => request(() => { rows.set(record.key, { ...record }) }),
    delete: (key: string) => request(() => { rows.delete(key) }),
    index: () => ({ openCursor: () => {
      const entries = [...rows.values()].sort((a, b) => a.at - b.at)
      let index = 0
      const cursor: Request = {}
      const step = () => queueMicrotask(() => {
        const value = entries[index++]
        cursor.result = value ? { value, primaryKey: value.key, continue: step } : null
        cursor.onsuccess?.()
      })
      step()
      return cursor
    } })
  }
  const database = { transaction: () => {
    const transaction: { oncomplete?: () => void; objectStore: () => typeof store } = { objectStore: () => store }
    setTimeout(() => transaction.oncomplete?.(), 0)
    return transaction
  } }
  return { open: () => request(() => database) }
}

let api: typeof import('../../../src/features/library/renderer/archive/archiveCoverStore')
const settle = () => new Promise(resolve => setTimeout(resolve, 5))
const record = (key: string, kind: StoredArchiveCover['kind'], rule?: number): StoredArchiveCover => ({
  key, documentId: key, fingerprint: 'fingerprint', kind, blob: new Blob(['cover']), bytes: 5, width: 100, height: 80, at: 1,
  ...(rule === undefined ? {} : { rule })
})

beforeAll(async () => {
  vi.stubGlobal('indexedDB', fakeIndexedDB())
  api = await import('../../../src/features/library/renderer/archive/archiveCoverStore')
})
beforeEach(() => { rows.clear() })

describe('persisted archive cover rule', () => {
  it('drops a single-page cover saved under the 1.3.0 threshold so the paper is decided again', async () => {
    rows.set('stale', record('stale', 'single'))
    expect(await api.readStoredArchiveCover('stale')).toBeNull()
    await settle()
    expect(rows.has('stale')).toBe(false)
  })

  it('keeps complete spreads from the earlier rule and single pages written under the current one', async () => {
    rows.set('spread', record('spread', 'spread'))
    await api.writeStoredArchiveCover(record('single', 'single'))
    expect(rows.get('single')?.rule).toBe(api.ARCHIVE_COVER_RULE)
    expect((await api.readStoredArchiveCover('spread'))?.kind).toBe('spread')
    expect((await api.readStoredArchiveCover('single'))?.kind).toBe('single')
    await settle()
    expect([...rows.keys()].sort()).toEqual(['single', 'spread'])
  })
})
