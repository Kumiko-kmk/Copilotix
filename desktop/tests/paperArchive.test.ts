import { describe, expect, it } from 'vitest'
import type { DocumentSummary } from '@shared/ipcSchemas'
import { ArchiveMomentum, damp, settlingWave, SHOULDER_PEAK } from '../src/renderer/paperArchive/archiveMotion'
import {
  cellForPaper,
  groupPapersByMonth,
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

describe('paper archive shelves', () => {
  it('groups papers into month shelves, newest month and newest paper first', () => {
    const october = paper('2026-10-15T10:00:00.000Z')
    const octoberLater = paper('2026-10-20T10:00:00.000Z')
    const august = paper('2026-08-12T10:00:00.000Z')
    const shelves = groupPapersByMonth([august, october, octoberLater])
    expect(shelves.map((shelf) => shelf.key)).toEqual(['2026-10', '2026-08'])
    expect(shelves[0].label).toBe('2026 年 10 月')
    expect(shelves[0].papers.map((item) => item.id)).toEqual([octoberLater.id, october.id])
  })

  it('puts papers with unreadable dates on a final shelf', () => {
    const shelves = groupPapersByMonth([paper('not-a-date'), paper('2026-01-15T10:00:00.000Z')])
    expect(shelves.map((shelf) => shelf.key)).toEqual(['2026-01', 'undated'])
  })

  it('loops rows and lanes in both directions', () => {
    const shelves = groupPapersByMonth([
      paper('2026-10-10T10:00:00.000Z'), paper('2026-10-11T10:00:00.000Z'), paper('2026-09-10T10:00:00.000Z')
    ])
    expect(wrap(-1, 3)).toBe(2)
    expect(paperAt(shelves, { lane: 0, row: 2 })).toBe(shelves[0].papers[0])
    expect(paperAt(shelves, { lane: -1, row: -5 })).toBe(shelves[1].papers[0])
    expect(paperIndexAt(shelves, { lane: 2, row: -1 })).toBe(1)
    expect(paperAt([], { lane: 0, row: 0 })).toBeNull()
  })

  it('finds the nearest occurrence so the plane never travels across a whole loop', () => {
    expect(nearestOccurrence(0, 7, 8)).toBe(8)
    expect(nearestOccurrence(3, -6, 8)).toBe(-5)
    const shelves = groupPapersByMonth([paper('2026-10-10T10:00:00.000Z'), paper('2026-10-11T10:00:00.000Z')])
    expect(cellForPaper(shelves, shelves[0].papers[1].id, { lane: 4, row: 9 })).toEqual({ lane: 4, row: 9 })
    expect(cellForPaper(shelves, 'missing', { lane: 0, row: 0 })).toBeNull()
  })

  it('returns to the paper last viewed on a shelf when stepping sideways', () => {
    const shelves = groupPapersByMonth([
      paper('2026-10-10T10:00:00.000Z'),
      paper('2026-09-10T10:00:00.000Z'), paper('2026-09-11T10:00:00.000Z'), paper('2026-09-12T10:00:00.000Z')
    ])
    const remembered = shelves[1].papers[2]
    const next = laneStep(shelves, { lane: 0, row: 10 }, 1, new Map([[shelves[1].key, remembered.id]]))
    expect(next.lane).toBe(1)
    expect(paperAt(shelves, next)).toBe(remembered)
    expect(Math.abs(next.row - 10)).toBeLessThanOrEqual(1)
    expect(paperAt(shelves, laneStep(shelves, { lane: 0, row: 0 }, -1, new Map()))).toBe(shelves[1].papers[0])
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
