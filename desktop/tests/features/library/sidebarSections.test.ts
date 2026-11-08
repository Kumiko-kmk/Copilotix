import { describe, expect, it } from 'vitest'
import { prunePins, sidebarSections, togglePin } from '../../../src/features/library/core/sidebarSections'

const paper = (id: string, day: number) => ({ id, createdAt: `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z` })
const papers = [paper('a', 1), paper('b', 2), paper('c', 3), paper('d', 4), paper('e', 5)]
const noPins = { global: [], group: [] }

describe('sidebar sections', () => {
  it('lists papers newest first without headings until categories arrive', () => {
    const sections = sidebarSections(papers, null, noPins)
    expect(sections.map((section) => [section.kind, section.papers.map((item) => item.id)])).toEqual([['new', ['e', 'd', 'c', 'b', 'a']]])
  })

  it('puts global pins on top, group pins first inside their category, and unknown papers in their own section', () => {
    const categories = [{ name: '断裂力学', paperIds: ['a', 'c', 'd'] }, { name: '材料', paperIds: ['b'] }]
    const sections = sidebarSections(papers, categories, { global: ['d'], group: ['a'] })
    expect(sections.map((section) => [section.name, section.papers.map((item) => item.id)])).toEqual([
      ['置顶', ['d']],
      ['未分组', ['e']],
      ['断裂力学', ['a', 'c']],
      ['材料', ['b']]
    ])
    // Keys follow the name, not the membership-derived category id, so folding survives a recomputation.
    expect(sections[2]!.key).toBe('category:断裂力学')
  })

  it('drops a category whose only paper is pinned globally', () => {
    const sections = sidebarSections(papers, [{ name: '材料', paperIds: ['b'] }, { name: '其他', paperIds: ['a', 'c', 'd', 'e'] }], { global: ['b'], group: [] })
    expect(sections.map((section) => section.name)).toEqual(['置顶', '其他'])
  })

  it('moves a paper between global and group pins instead of keeping both', () => {
    const grouped = togglePin(noPins, 'a', 'group')
    expect(grouped).toEqual({ global: [], group: ['a'] })
    expect(togglePin(grouped, 'a', 'global')).toEqual({ global: ['a'], group: [] })
    expect(togglePin({ global: ['a'], group: [] }, 'a', 'global')).toEqual({ global: [], group: [] })
  })

  it('forgets pins of deleted papers and keeps the same object when nothing changed', () => {
    const pins = { global: ['a', 'x'], group: ['b'] }
    expect(prunePins(pins, new Set(['a', 'b']))).toEqual({ global: ['a'], group: ['b'] })
    const kept = { global: ['a'], group: [] }
    expect(prunePins(kept, new Set(['a']))).toBe(kept)
  })
})
