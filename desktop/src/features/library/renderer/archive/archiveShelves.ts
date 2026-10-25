import type { DocumentSummary } from '@shared/ipcSchemas'
import { ALL_PAPERS_NAME } from '../../contract/libraryCategories'

export type ArchivePaper = Pick<DocumentSummary, 'id' | 'displayName' | 'originalName' | 'createdAt' | 'workflow'>

export interface ArchiveShelf {
  /** Stable category id; each category occupies one column. */
  key: string
  label: string
  /** Category name shared by every column of the same category. */
  category: string
  papers: ArchivePaper[]
}

/** A content category from the Utility (shared/libraryCategories.ts), papers most typical first. */
export interface ArchiveCategory {
  id: string
  name: string
  paperIds: readonly string[]
}

/** Shown until the library's categories arrive, or when they are unavailable. */
export const ALL_PAPERS = ALL_PAPERS_NAME
const UNSORTED = { id: 'pending', name: '待分类' }

/** Physical position in the unbounded, looping archive plane. */
export type ArchiveCell = { lane: number; row: number }

export function wrap(value: number, count: number): number {
  return ((value % count) + count) % count
}

/** The occurrence of `value` (mod `period`) nearest to `center`. */
export function nearestOccurrence(value: number, center: number, period: number): number {
  return value + Math.floor((center - value + period / 2) / period) * period
}

/**
 * One shelf per content category, in the order given (largest first) and with each category's
 * papers in its own order. Papers the categories do not know yet (just imported) join 待分类.
 * Without categories the whole library is one shelf, newest first.
 */
export function groupPapersByCategory(papers: readonly ArchivePaper[], categories?: readonly ArchiveCategory[] | null): ArchiveShelf[] {
  const newestFirst = (a: ArchivePaper, b: ArchivePaper): number => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
  if (!categories?.length) return papers.length ? [{ key: 'all', label: ALL_PAPERS, category: ALL_PAPERS, papers: papers.slice().sort(newestFirst) }] : []
  const byId = new Map(papers.map((paper) => [paper.id, paper]))
  const placed = new Set<string>()
  const shelves: ArchiveShelf[] = []
  for (const category of categories) {
    const members = category.paperIds.flatMap((id) => {
      const paper = byId.get(id)
      if (!paper || placed.has(id)) return []
      placed.add(id)
      return [paper]
    })
    if (members.length) shelves.push({ key: category.id, label: category.name, category: category.name, papers: members })
  }
  const unsorted = papers.filter((paper) => !placed.has(paper.id)).sort(newestFirst)
  if (unsorted.length) {
    const pending = shelves.find((shelf) => shelf.key === UNSORTED.id)
    if (pending) pending.papers.push(...unsorted)
    else shelves.push({ key: UNSORTED.id, label: UNSORTED.name, category: UNSORTED.name, papers: unsorted })
  }
  return shelves
}

/**
 * One column per category. All its papers remain in their original order and loop vertically.
 */
export function buildArchiveColumns(papers: readonly ArchivePaper[], categories?: readonly ArchiveCategory[] | null): ArchiveShelf[] {
  return groupPapersByCategory(papers, categories)
}

export function shelfAt(shelves: readonly ArchiveShelf[], lane: number): ArchiveShelf | null {
  return shelves.length ? shelves[wrap(lane, shelves.length)] ?? null : null
}

export function paperIndexAt(shelves: readonly ArchiveShelf[], cell: ArchiveCell): number {
  const shelf = shelfAt(shelves, cell.lane)
  return shelf ? wrap(cell.row, shelf.papers.length) : 0
}

export function paperAt(shelves: readonly ArchiveShelf[], cell: ArchiveCell): ArchivePaper | null {
  const shelf = shelfAt(shelves, cell.lane)
  return shelf?.papers.length ? shelf.papers[wrap(cell.row, shelf.papers.length)] ?? null : null
}

/** Where a paper sits, or null once it has left the archive. */
export function locatePaper(shelves: readonly ArchiveShelf[], paperId: string): { shelf: number; index: number } | null {
  for (const [shelf, column] of shelves.entries()) {
    const index = column.papers.findIndex((paper) => paper.id === paperId)
    if (index >= 0) return { shelf, index }
  }
  return null
}

/** The physical cell for `paperId` nearest to `current`, so the plane never jumps across a loop. */
export function cellForPaper(shelves: readonly ArchiveShelf[], paperId: string, current: ArchiveCell): ArchiveCell | null {
  const location = locatePaper(shelves, paperId)
  if (!location) return null
  const shelf = shelves[location.shelf]
  if (!shelf?.papers.length) return null
  return {
    lane: nearestOccurrence(location.shelf, current.lane, shelves.length),
    row: nearestOccurrence(location.index, current.row, shelf.papers.length)
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
