import type { CoreListCursor } from '../contract/rpc'
import { CORE_LIST_PAGE_MAX_ROWS } from '../contract/rpc'

/** Leaves ample room under the 1 MiB envelope for JSON framing. */
export const LIST_PAGE_MAX_BYTES = 512 * 1024

/**
 * Read up to CORE_LIST_PAGE_MAX_ROWS rows after `after`, then keep only as
 * many as fit the byte budget (always at least one). Rows that did not fit
 * are read again for the next page.
 */
export function byteBoundedPage<T extends { id: string; createdAt: string }>(
  readPage: (after: CoreListCursor | null, limit: number) => T[],
  after: CoreListCursor | null,
  maxBytes = LIST_PAGE_MAX_BYTES
): { items: T[]; next: CoreListCursor | null } {
  const rows = readPage(after, CORE_LIST_PAGE_MAX_ROWS)
  const items: T[] = []
  let bytes = 0
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8')
    if (items.length > 0 && bytes + size > maxBytes) break
    items.push(row)
    bytes += size
  }
  const last = items.at(-1)
  const hasMore = items.length < rows.length || rows.length === CORE_LIST_PAGE_MAX_ROWS
  return { items, next: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null }
}
