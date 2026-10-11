import { describe, expect, it } from 'vitest'
import { projectFigureMarkdown, type FigureArtifact } from '../src/shared/figureArtifacts'
const figure: FigureArtifact = {
  figureId: 'figure-1', imagePath: 'images/figures/figure-p1-abcdef.png', sourceRevision: 'revision',
  pageIndex: 0, cropBox: [0, 0, 100, 100], mappingIds: ['a', 'b', 'caption'], sourceAssets: ['a.png', 'b.png'],
  width: 100, height: 100, pngSha256: 'hash'
}

describe('whole figure Markdown projection', () => {
  it('replaces only owned image references and keeps mixed prose, captions and unrelated assets', () => {
    const source = 'Before.\n\n![A](images/a.png)\n\nMiddle.\n\n<img src="images/b.png">\n\n![Other](images/other.png)\n\nFigure 1. First paragraph.\n\nSecond paragraph.'
    const projected = projectFigureMarkdown(source, [figure])
    expect(projected.match(/images\/figures/gu)).toHaveLength(1)
    expect(projected).not.toContain('images/a.png')
    expect(projected).not.toContain('images/b.png')
    expect(projected).toContain('Middle.')
    expect(projected).toContain('images/other.png')
    expect(projected).toContain('Second paragraph.')
  })
  it('preserves conflicting, remote and unavailable sources and supports reference-style images', () => {
    const conflict = { ...figure, figureId: 'figure-2' }
    expect(projectFigureMarkdown('![](images/a.png)', [figure, conflict])).toBe('![](images/a.png)')
    expect(projectFigureMarkdown('![](https://example.com/a.png)', [figure])).toBe('![](https://example.com/a.png)')
    expect(projectFigureMarkdown('![A][panel]\n\n[panel]: images/a.png', [figure])).toContain('![](images/figures/')
    expect(projectFigureMarkdown('<div><img src="images/a.png"></div>', [figure])).toContain('<img src="images/figures/')
    expect(projectFigureMarkdown('![](images/a.png)', [])).toBe('![](images/a.png)')
  })
})
