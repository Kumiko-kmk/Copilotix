import { describe, expect, it } from 'vitest'
import { layoutSpreadFigures, parseFigureManifest, rankSpreadFigures, type SpreadCandidate } from '../src/renderer/paperArchive/figureSpread'

const SHEET = { width: 1236, height: 1600 }

function candidate(figureId: string, aspect: number, weight = 1): SpreadCandidate {
  return { figureId, imagePath: `images/figures/${figureId}.png`, aspect, weight }
}

function manifestFigure(figureId: string, pageIndex: number, width = 1800, height = 700, area = 100) {
  return { figureId, imagePath: `images/figures/${figureId}.png`, width, height, pageIndex, cropBox: [0, 0, area, 100] }
}

describe('layoutSpreadFigures', () => {
  it('keeps every figure inside the sheet margins, readable and without overlaps', () => {
    const placements = layoutSpreadFigures([candidate('a', 1.1), candidate('b', 3), candidate('c', 2.2), candidate('d', 0.8), candidate('e', 2.6)], SHEET)
    expect(placements.length).toBeGreaterThan(0)
    expect(placements.length).toBeLessThanOrEqual(6)
    for (const [index, placement] of placements.entries()) {
      expect(placement.x).toBeGreaterThan(0)
      expect(placement.y).toBeGreaterThan(0)
      expect(placement.x + placement.width).toBeLessThan(SHEET.width)
      expect(placement.y + placement.height).toBeLessThan(SHEET.height)
      expect(Math.min(placement.width, placement.height)).toBeGreaterThanOrEqual(SHEET.width * 0.83 * 0.24 - 0.5)
      for (const other of placements.slice(index + 1)) {
        const apart = placement.x + placement.width <= other.x || other.x + other.width <= placement.x
          || placement.y + placement.height <= other.y || other.y + other.height <= placement.y
        expect(apart).toBe(true)
      }
    }
  })

  it('shows more figures when they keep a readable size', () => {
    const placements = layoutSpreadFigures([candidate('a', 1.6), candidate('b', 0.62), candidate('c', 1.33), candidate('d', 0.77), candidate('e', 2.68)], SHEET)
    expect(placements.length).toBeGreaterThanOrEqual(4)
  })

  it('places figures in rank order and never puts two wide figures side by side', () => {
    const placements = layoutSpreadFigures([candidate('a', 3), candidate('b', 3.2), candidate('c', 2.8), candidate('d', 3)], SHEET)
    expect(placements[0]!.figureId).toBe('a')
    const rows = new Set(placements.map((placement) => Math.round(placement.y)))
    expect(rows.size).toBe(placements.length)
  })

  it('shows a single figure alone, centred, and nothing without candidates', () => {
    const [only] = layoutSpreadFigures([candidate('a', 1.3)], SHEET)
    expect(only!.x + only!.width / 2).toBeCloseTo(SHEET.width / 2, 0)
    expect(only!.y + only!.height / 2).toBeCloseTo(SHEET.height / 2, 0)
    expect(layoutSpreadFigures([], SHEET)).toEqual([])
  })
})

describe('rankSpreadFigures', () => {
  it('ranks scored figures by displayWeight before unscored ones and drops zero scores', () => {
    const figures = [manifestFigure('late', 9), manifestFigure('scored-low', 4), manifestFigure('formula', 2), manifestFigure('scored-high', 6)]
    const ranked = rankSpreadFigures(figures, new Map([['scored-low', 40], ['scored-high', 90], ['formula', 0]]))
    expect(ranked.map((figure) => figure.figureId)).toEqual(['scored-high', 'scored-low', 'late'])
  })

  it('skips figures on the first page and extreme strips', () => {
    const ranked = rankSpreadFigures([manifestFigure('cover', 0), manifestFigure('strip', 3, 1800, 200), manifestFigure('kept', 3)], new Map())
    expect(ranked.map((figure) => figure.figureId)).toEqual(['kept'])
  })

  it('prefers earlier and larger figures when nothing is scored', () => {
    const ranked = rankSpreadFigures([manifestFigure('appendix', 20, 1800, 700, 100), manifestFigure('method', 2, 1800, 700, 100)], new Map())
    expect(ranked[0]!.figureId).toBe('method')
  })
})

describe('parseFigureManifest', () => {
  it('accepts only well-formed figures with paths inside images/figures', () => {
    const figures = parseFigureManifest({ version: 1, figures: [
      manifestFigure('ok', 2),
      { ...manifestFigure('escape', 2), imagePath: '../secret.png' },
      { ...manifestFigure('broken', 2), width: 0 }
    ] })
    expect(figures.map((figure) => figure.figureId)).toEqual(['ok'])
    expect(parseFigureManifest(null)).toEqual([])
  })
})
