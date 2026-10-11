import { describe, expect, it } from 'vitest'
import { viewerParts } from '../src/renderer/paperArchive/archiveViewer'

describe('viewerParts', () => {
  it('orders the shell in front, one part per section, the carrier behind', () => {
    const parts = viewerParts([{ label: '引言' }, { label: '方法' }, { label: '实验' }])
    expect(parts.map((part) => part.id)).toEqual(['fasteners', 'cover', 'section-0', 'section-1', 'section-2', 'carrier'])
    expect(parts.map((part) => part.label).slice(2, 5)).toEqual(['引言', '方法', '实验'])
    const depths = parts.map((part) => part.depth)
    for (let index = 1; index < depths.length; index++) expect(depths[index]).toBeLessThan(depths[index - 1]!)
  })

  it('keeps a single section between the cover and the carrier', () => {
    const parts = viewerParts([{ label: '全文' }])
    expect(parts[2]!.depth).toBeLessThan(parts[1]!.depth)
    expect(parts[2]!.depth).toBeGreaterThan(parts[3]!.depth)
  })
})
