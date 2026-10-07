import type { DocumentSummary } from '@shared/ipcSchemas'

export type ArchivePaper = Pick<DocumentSummary, 'id' | 'displayName' | 'originalName' | 'createdAt' | 'workflow'>

export interface ArchiveShelf {
  /** Stable key, `YYYY-MM` or `undated`. */
  key: string
  label: string
  papers: ArchivePaper[]
}

/** Physical position in the unbounded, looping archive plane. */
export type ArchiveCell = { lane: number; row: number }

export function wrap(value: number, count: number): number {
  return ((value % count) + count) % count
}

/** The occurrence of `value` (mod `period`) nearest to `center`. */
export function nearestOccurrence(value: number, center: number, period: number): number {
  return value + Math.floor((center - value + period / 2) / period) * period
}

/** One shelf per calendar month, newest month first and newest paper first. */
export function groupPapersByMonth(papers: readonly ArchivePaper[]): ArchiveShelf[] {
  const shelves = new Map<string, ArchivePaper[]>()
  for (const paper of papers) {
    const key = monthKey(paper.createdAt)
    const shelf = shelves.get(key)
    if (shelf) shelf.push(paper)
    else shelves.set(key, [paper])
  }
  return [...shelves.entries()]
    .sort(([a], [b]) => (a === 'undated' ? 1 : b === 'undated' ? -1 : b.localeCompare(a)))
    .map(([key, items]) => ({
      key,
      label: monthLabel(key),
      papers: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    }))
}

function monthKey(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'undated'
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function monthLabel(key: string): string {
  if (key === 'undated') return '未标注日期'
  const [year, month] = key.split('-')
  return `${year} 年 ${Number(month)} 月`
}

export function shelfAt(shelves: readonly ArchiveShelf[], lane: number): ArchiveShelf | null {
  return shelves.length ? shelves[wrap(lane, shelves.length)] : null
}

export function paperIndexAt(shelves: readonly ArchiveShelf[], cell: ArchiveCell): number {
  const shelf = shelfAt(shelves, cell.lane)
  return shelf ? wrap(cell.row, shelf.papers.length) : 0
}

export function paperAt(shelves: readonly ArchiveShelf[], cell: ArchiveCell): ArchivePaper | null {
  const shelf = shelfAt(shelves, cell.lane)
  return shelf ? shelf.papers[wrap(cell.row, shelf.papers.length)] : null
}

/** Where a paper sits, or null once it has left the archive. */
export function locatePaper(shelves: readonly ArchiveShelf[], paperId: string): { shelf: number; index: number } | null {
  for (let shelf = 0; shelf < shelves.length; shelf++) {
    const index = shelves[shelf].papers.findIndex((paper) => paper.id === paperId)
    if (index >= 0) return { shelf, index }
  }
  return null
}

/** The physical cell for `paperId` nearest to `current`, so the plane never jumps across a loop. */
export function cellForPaper(shelves: readonly ArchiveShelf[], paperId: string, current: ArchiveCell): ArchiveCell | null {
  const location = locatePaper(shelves, paperId)
  if (!location) return null
  return {
    lane: nearestOccurrence(location.shelf, current.lane, shelves.length),
    row: nearestOccurrence(location.index, current.row, shelves[location.shelf].papers.length)
  }
}

/**
 * Step one lane sideways, landing on the paper last viewed in that shelf
 * (or its first paper), at the row occurrence nearest the current one.
 */
export function laneStep(
  shelves: readonly ArchiveShelf[],
  current: ArchiveCell,
  direction: number,
  memory: ReadonlyMap<string, string>
): ArchiveCell {
  const lane = current.lane + direction
  const shelf = shelfAt(shelves, lane)
  if (!shelf) return { lane, row: current.row }
  const rememberedId = memory.get(shelf.key)
  const index = Math.max(0, rememberedId ? shelf.papers.findIndex((paper) => paper.id === rememberedId) : 0)
  return { lane, row: nearestOccurrence(index, current.row, shelf.papers.length) }
}
