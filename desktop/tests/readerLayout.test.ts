// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import {
  LAYOUT_STORAGE_KEY,
  activateView,
  adjacentGroup,
  defaultReaderLayout,
  equalizeSplit,
  groupOfView,
  hideView,
  listGroups,
  loadReaderLayout,
  moveView,
  normalizeLayout,
  resizeSplit,
  revealView,
  splitView,
  visibleViews,
  type LayoutSplit,
  type ReaderLayout
} from '../src/renderer/readerLayout'

afterEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})

const shape = (layout: ReaderLayout): unknown => {
  const walk = (node: ReaderLayout['root']): unknown => node.kind === 'group'
    ? { views: node.views, active: node.active }
    : { [node.direction]: node.children.map(walk), sizes: node.sizes.map((size) => Math.round(size)) }
  return { root: walk(layout.root), hidden: layout.hidden }
}

describe('reader layout model', () => {
  it('defaults to the classic PDF | Markdown·中文·问答 reader', () => {
    expect(shape(defaultReaderLayout())).toEqual({
      root: { row: [{ views: ['pdf'], active: 'pdf' }, { views: ['original', 'translated', 'chat'], active: 'original' }], sizes: [49, 51] },
      hidden: []
    })
  })

  it('seeds the PDF width from the legacy split preference', () => {
    window.sessionStorage.setItem('copilotix.reader.split-percent', '56')
    expect((loadReaderLayout().root as LayoutSplit).sizes.map(Math.round)).toEqual([56, 44])
  })

  it('splits a tab into a new group beside its own group', () => {
    const layout = splitView(defaultReaderLayout(), 'chat', 'g2', 'right')
    // Same direction as the parent row: the new group shares the target's slot.
    expect(shape(layout)).toEqual({
      root: {
        row: [
          { views: ['pdf'], active: 'pdf' },
          { views: ['original', 'translated'], active: 'original' },
          { views: ['chat'], active: 'chat' }
        ],
        sizes: [49, 26, 26]
      },
      hidden: []
    })
  })

  it('nests a column split when splitting downwards', () => {
    const layout = splitView(defaultReaderLayout(), 'translated', 'g2', 'bottom')
    expect(shape(layout)).toEqual({
      root: {
        row: [
          { views: ['pdf'], active: 'pdf' },
          { column: [{ views: ['original', 'chat'], active: 'original' }, { views: ['translated'], active: 'translated' }], sizes: [50, 50] }
        ],
        sizes: [49, 51]
      },
      hidden: []
    })
  })

  it('refuses to split a group’s only view next to itself', () => {
    const layout = defaultReaderLayout()
    expect(splitView(layout, 'pdf', 'g1', 'right')).toBe(layout)
  })

  it('moves views between groups and removes groups that become empty', () => {
    const moved = moveView(defaultReaderLayout(), 'pdf', 'g2', 0)
    expect(shape(moved)).toEqual({
      root: { views: ['pdf', 'original', 'translated', 'chat'], active: 'pdf' },
      hidden: []
    })
    expect(listGroups(moved.root)).toHaveLength(1)
  })

  it('reorders tabs when a view is dropped back into its own group', () => {
    const layout = defaultReaderLayout()
    // Slot 3 = after the last tab; slot 0 = before the first.
    expect(moveView(layout, 'original', 'g2', 3).root).toMatchObject({ children: [{}, { views: ['translated', 'chat', 'original'], active: 'original' }] })
    expect(moveView(layout, 'chat', 'g2', 0).root).toMatchObject({ children: [{}, { views: ['chat', 'original', 'translated'], active: 'chat' }] })
    // Dropping a tab next to itself only selects it.
    expect(moveView(layout, 'translated', 'g2', 2).root).toMatchObject({ children: [{}, { views: ['original', 'translated', 'chat'], active: 'translated' }] })
  })

  it('finds neighbouring groups in reading order', () => {
    const layout = splitView(defaultReaderLayout(), 'chat', 'g2', 'bottom')
    const order = listGroups(layout.root).map((group) => group.id)
    expect(adjacentGroup(layout, order[0]!, 1)?.id).toBe(order[1])
    expect(adjacentGroup(layout, order[0]!, -1)).toBeUndefined()
    expect(adjacentGroup(layout, order.at(-1)!, 1)).toBeUndefined()
  })

  it('hides and reopens views but never hides the last visible one', () => {
    let layout = hideView(defaultReaderLayout(), 'translated')
    expect(layout.hidden).toEqual(['translated'])
    expect(groupOfView(layout, 'translated')).toBeUndefined()
    layout = revealView(layout, 'translated', 'g1')
    expect(groupOfView(layout, 'translated')?.id).toBe('g1')
    expect(groupOfView(layout, 'translated')?.active).toBe('translated')

    let single = moveView(defaultReaderLayout(), 'pdf', 'g2')
    for (const view of ['pdf', 'original', 'translated'] as const) single = hideView(single, view)
    expect(visibleViews(single)).toEqual(['chat'])
    expect(hideView(single, 'chat')).toBe(single)
  })

  it('activates, resizes and equalizes', () => {
    const layout = activateView(defaultReaderLayout(), 'chat')
    expect(groupOfView(layout, 'chat')?.active).toBe('chat')
    const resized = resizeSplit(layout, 's1', [30, 90])
    expect((resized.root as LayoutSplit).sizes).toEqual([25, 75])
    expect((equalizeSplit(resized, 's1').root as LayoutSplit).sizes).toEqual([50, 50])
  })

  it('repairs untrusted stored layouts', () => {
    const repaired = normalizeLayout({
      version: 1,
      hidden: ['bogus', 'chat'],
      root: {
        kind: 'split', id: 'outer', direction: 'row', sizes: [-1, 'x', 3],
        children: [
          { kind: 'group', id: 'a', views: ['pdf', 'pdf', 'nope'], active: 'nope' },
          { kind: 'group', id: 'a', views: [], active: 'pdf' },
          { kind: 'split', id: 'inner', direction: 'row', sizes: [1, 1], children: [
            { kind: 'group', id: 'b', views: ['original', 'chat'], active: 'chat' },
            { kind: 'group', id: 'c', views: ['pdf'], active: 'pdf' }
          ] }
        ]
      }
    })
    const groups = listGroups(repaired.root)
    expect(groups.map((group) => group.views)).toEqual([['pdf'], ['original', 'chat']])
    expect(groups[0]!.active).toBe('pdf')
    expect(new Set(groups.map((group) => group.id)).size).toBe(groups.length)
    expect(repaired.hidden).toEqual(['translated'])
    expect((repaired.root as LayoutSplit).sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(100)
    expect(normalizeLayout({ version: 2 })).toEqual(defaultReaderLayout())
    expect(normalizeLayout(null)).toEqual(defaultReaderLayout())
  })

  it('falls back to the default layout for corrupt storage', () => {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, '{not json')
    expect(loadReaderLayout()).toEqual(defaultReaderLayout())
  })
})
