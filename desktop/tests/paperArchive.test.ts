import { describe, expect, it } from 'vitest'
import type { DocumentSummary } from '@shared/ipcSchemas'
import { ArchiveMomentum, damp, settlingWave, SHOULDER_PEAK } from '../src/renderer/paperArchive/archiveMotion'
import {
  ALL_PAPERS,
  buildArchiveColumns,
  cellForPaper,
  groupPapersByCategory,
  laneStep,
  nearestOccurrence,
  paperAt,
  paperIndexAt,
  wrap,
  type ArchivePaper
} from '../src/renderer/paperArchive/archiveShelves'

let sequence = 0
function paper(createdAt: string, status: DocumentSummary['workflow']['status'] = 'completed'): ArchivePaper {
  sequence++
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    displayName: `paper-${sequence}.pdf`,
    originalName: `paper-${sequence}.pdf`,
    createdAt,
    workflow: { status, progress: 100, activeJobKind: null, error: null }
  }
}

const october = '2026-10-15T10:00:00.000Z'

describe('paper archive shelves', () => {
  it('shows the whole library as one shelf, newest first, until categories arrive', () => {
    const older = paper('2026-08-12T10:00:00.000Z')
    const newer = paper('2026-10-20T10:00:00.000Z')
    const shelves = groupPapersByCategory([older, newer])
    expect(shelves.map((shelf) => [shelf.key, shelf.label, shelf.category])).toEqual([['all', ALL_PAPERS, ALL_PAPERS]])
    expect(shelves[0]!.papers.map((item) => item.id)).toEqual([newer.id, older.id])
    expect(groupPapersByCategory([])).toEqual([])
  })

  it('follows the category order and the order of papers within each category', () => {
    const [a, b, c, d] = [paper(october), paper(october), paper(october), paper(october)]
    const shelves = groupPapersByCategory([a!, b!, c!, d!], [
      { id: 'c-operators', name: '神经算子', paperIds: [c!.id, a!.id] },
      { id: 'c-attention', name: '注意力机制', paperIds: [b!.id, 'deleted-paper'] }
    ])
    expect(shelves.map((shelf) => shelf.label)).toEqual(['神经算子', '注意力机制', '待分类'])
    expect(shelves[0]!.papers).toEqual([c, a])
    // A paper imported after the categories were computed waits in 待分类.
    expect(shelves[2]!.papers).toEqual([d])
  })

  it('adds papers the categories do not know to an existing 待分类 shelf', () => {
    const [a, b] = [paper(october), paper(october)]
    const shelves = groupPapersByCategory([a!, b!], [{ id: 'pending', name: '待分类', paperIds: [a!.id] }])
    expect(shelves.map((shelf) => [shelf.key, shelf.papers.length])).toEqual([['pending', 2]])
  })

  it('loops rows and lanes in both directions', () => {
    const [a, b, c] = [paper(october), paper(october), paper(october)]
    const shelves = groupPapersByCategory([a!, b!, c!], [{ id: 'c-x', name: 'X', paperIds: [a!.id, b!.id] }, { id: 'c-y', name: 'Y', paperIds: [c!.id] }])
    expect(wrap(-1, 3)).toBe(2)
    expect(paperAt(shelves, { lane: 0, row: 2 })).toBe(shelves[0]!.papers[0]!)
    expect(paperAt(shelves, { lane: -1, row: -5 })).toBe(shelves[1]!.papers[0]!)
    expect(paperIndexAt(shelves, { lane: 2, row: -1 })).toBe(1)
    expect(paperAt([], { lane: 0, row: 0 })).toBeNull()
  })

  it('finds the nearest occurrence so the plane never travels across a whole loop', () => {
    expect(nearestOccurrence(0, 7, 8)).toBe(8)
    expect(nearestOccurrence(3, -6, 8)).toBe(-5)
    const shelves = groupPapersByCategory([paper('2026-10-10T10:00:00.000Z'), paper('2026-10-11T10:00:00.000Z')])
    expect(cellForPaper(shelves, shelves[0]!.papers[1]!.id, { lane: 4, row: 9 })).toEqual({ lane: 4, row: 9 })
    expect(cellForPaper(shelves, 'missing', { lane: 0, row: 0 })).toBeNull()
  })

  it('returns to the paper last viewed on a shelf when stepping sideways', () => {
    const papers = [paper(october), paper(october), paper(october), paper(october)]
    const shelves = groupPapersByCategory(papers, [
      { id: 'c-x', name: 'X', paperIds: [papers[0]!.id] },
      { id: 'c-y', name: 'Y', paperIds: papers.slice(1).map((item) => item.id) }
    ])
    const remembered = shelves[1]!.papers[2]!
    const next = laneStep(shelves, { lane: 0, row: 10 }, 1, new Map([[shelves[1]!.key, remembered.id]]))
    expect(next.lane).toBe(1)
    expect(paperAt(shelves, next)).toBe(remembered)
    expect(Math.abs(next.row - 10)).toBeLessThanOrEqual(1)
    expect(paperAt(shelves, laneStep(shelves, { lane: 0, row: 0 }, -1, new Map()))).toBe(shelves[1]!.papers[0]!)
  })
})

describe('paper archive columns', () => {
  it('keeps every paper in a large category in one looping column', () => {
    const papers = Array.from({ length: 37 }, () => paper(october))
    const columns = buildArchiveColumns(papers, [{ id: 'c-big', name: '神经算子', paperIds: papers.map((item) => item.id) }])
    expect(columns).toHaveLength(1)
    expect(columns.every((column) => column.category === '神经算子')).toBe(true)
    expect(columns[0]!.papers).toEqual(papers)
    expect(columns[0]!.label).toBe('神经算子')
    expect(columns[0]!.key).toBe('c-big')
    expect(paperAt(columns, { lane: 0, row: 36 })).toBe(papers[36])
    expect(paperAt(columns, { lane: 1, row: 37 })).toBe(papers[0])
    expect(paperAt(columns, { lane: -1, row: -1 })).toBe(papers[36])
    expect(columns.flatMap((column) => column.papers)).toHaveLength(37)
  })

  it('keeps small categories as single columns', () => {
    const [a, b] = [paper(october), paper(october)]
    const columns = buildArchiveColumns([a!, b!], [{ id: 'c-x', name: '扩散模型', paperIds: [a!.id] }, { id: 'c-y', name: '图网络', paperIds: [b!.id] }])
    expect(columns.map((column) => [column.key, column.label])).toEqual([['c-x', '扩散模型'], ['c-y', '图网络']])
  })
})

describe('paper archive motion', () => {
  it('keeps the resting shoulder highest at the selection and settling outward', () => {
    expect(SHOULDER_PEAK).toBeGreaterThan(2)
    expect(settlingWave(6)).toBeLessThan(SHOULDER_PEAK)
    expect(settlingWave(20)).toBeLessThan(settlingWave(6))
    expect(settlingWave(-6)).toBeCloseTo(settlingWave(6))
  })

  it('damps springs onto their target', () => {
    const spring = { value: 0, velocity: 0 }
    for (let step = 0; step < 240; step++) damp(spring, 1, 5, 1 / 60)
    expect(spring.value).toBeCloseTo(1, 3)
  })

  it('coasts a released drag and snaps to a whole cell', () => {
    const momentum = new ArchiveMomentum(0.2, 6)
    for (let step = 0; step < 600 && momentum.phase !== 'idle'; step++) momentum.step(1 / 60)
    expect(momentum.phase).toBe('idle')
    expect(Number.isInteger(momentum.value)).toBe(true)
    expect(momentum.value).toBeGreaterThan(1)
  })
})
