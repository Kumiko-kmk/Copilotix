import { describe, expect, it } from 'vitest'
import { applyTextLayerRepairs, findTextLayerCandidates, isFragmentedText, planTextLayerRepairs, type TextLayerItem } from '@shared/textLayerRepair'

const GARBLED = 'd h f ld h h d f l ll d h d'
const REAL = '(CZM) and phase-field approaches. The advent of computational power allowed researchers and'

/** One line of word items on the baseline of a clipped MinerU span [196, 322, 504, 328]. */
function lineItems(text: string, x0 = 197, baseline = 328.5, height = 7.2): TextLayerItem[] {
  let x = x0
  return text.split(' ').map((word) => {
    const item: TextLayerItem = { text: word, bbox: [x, baseline - 0.8 * height, x + word.length * 3.4, baseline + 0.2 * height] }
    x += word.length * 3.4 + 2.2
    return item
  })
}

function layoutWith(spans: Array<{ type: string; content: string; bbox: number[] }>, extra: Record<string, unknown> = {}): unknown {
  return { pdf_info: [{ page_idx: 0, page_size: [544, 742], para_blocks: [{ type: 'text', bbox: [190, 300, 510, 350], lines: [{ bbox: [196, 322, 504, 328], spans }], ...extra }] }] }
}

describe('text-layer repair of fragmented parser lines', () => {
  it('flags glyph-loss remnants but not prose, initials, spaced headings or short formulas', () => {
    expect(isFragmentedText(GARBLED)).toBe(true)
    expect(isFragmentedText('( ) h h d b b dl l ifi d i h i di h i d l hl')).toBe(true)
    expect(isFragmentedText(REAL)).toBe(false)
    expect(isFragmentedText('A R T I C L E I N F O')).toBe(false)
    expect(isFragmentedText('[110] Hao, Z., Yao, J., Su, C., Su, H., Wang, Z., Lu, F., Xia, Z.')).toBe(false)
    expect(isFragmentedText('if x ∈ ∂Ω and')).toBe(false)
  })

  it('replaces a confirmed line in the layout and Markdown together, escaping Markdown syntax', () => {
    const layout = layoutWith([{ type: 'text', content: GARBLED, bbox: [196, 322, 504, 328] }])
    const markdown = `Cohesive Zone Model ${GARBLED} engineers to conduct\n`
    const candidates = findTextLayerCandidates(layout)
    expect(candidates).toHaveLength(1)
    const layer = [{ pageIndex: 0, items: [...lineItems(REAL.replace('power', 'power_*')), ...lineItems('previous line text here', 197, 318.9)] }]
    const result = applyTextLayerRepairs(layout, markdown, planTextLayerRepairs(candidates, layer))
    expect(result.report.repairs).toHaveLength(1)
    expect(result.markdown).toBe(`Cohesive Zone Model ${REAL.replace('power', 'power\\_\\*')} engineers to conduct\n`)
    expect(JSON.stringify(result.layout)).toContain('power_*')
    expect(JSON.stringify(layout)).toContain(GARBLED)
    // Idempotent: the repaired layout has nothing left to repair.
    expect(findTextLayerCandidates(result.layout)).toEqual([])
  })

  it('leaves spans inside blocks the user edited or deleted untouched', () => {
    const layout = layoutWith([{ type: 'text', content: GARBLED, bbox: [196, 322, 504, 328] }])
    const markdown = `Cohesive Zone Model ${GARBLED} engineers to conduct\n`
    const report = planTextLayerRepairs(findTextLayerCandidates(layout), [{ pageIndex: 0, items: lineItems(REAL) }])
    const result = applyTextLayerRepairs(layout, markdown, report, [markdown.trim()])
    expect(result.markdown).toBe(markdown)
    expect(result.report.repairs).toEqual([])
    expect(JSON.stringify(result.layout)).toContain(GARBLED)
  })

  it('keeps the parser text without a readable text layer (scanned page, unrelated or garbled layer)', () => {
    const layout = layoutWith([{ type: 'text', content: GARBLED, bbox: [196, 322, 504, 328] }])
    const markdown = `${GARBLED}\n`
    const candidates = findTextLayerCandidates(layout)
    for (const items of [[], lineItems('Totally different words appear on this particular line'), lineItems('x y z � q r s t u v w')]) {
      const result = applyTextLayerRepairs(layout, markdown, planTextLayerRepairs(candidates, [{ pageIndex: 0, items }]))
      expect(result.report.repairs).toEqual([])
      expect(result.markdown).toBe(markdown)
    }
    expect(planTextLayerRepairs(candidates, []).unresolved).toHaveLength(1)
  })

  it('never touches equation spans and drops a repair whose Markdown position is ambiguous', () => {
    const layout = layoutWith([{ type: 'inline_equation', content: GARBLED, bbox: [196, 322, 504, 328] }])
    expect(findTextLayerCandidates(layout)).toEqual([])
    const textLayout = layoutWith([{ type: 'text', content: GARBLED, bbox: [196, 322, 504, 328] }])
    const twice = `${GARBLED}\n\n${GARBLED}\n`
    const result = applyTextLayerRepairs(textLayout, twice, planTextLayerRepairs(findTextLayerCandidates(textLayout), [{ pageIndex: 0, items: lineItems(REAL) }]))
    expect(result.report.repairs).toEqual([])
    expect(result.report.unresolved).toHaveLength(1)
    expect(result.markdown).toBe(twice)
  })

  it('reads lines that a cross-page paragraph merge moved from the next page', () => {
    const layout = { pdf_info: [
      { page_idx: 0, page_size: [544, 742], para_blocks: [{ type: 'text', bbox: [38, 600, 504, 700], lines: [{ bbox: [196, 322, 504, 328], spans: [{ type: 'text', content: GARBLED, bbox: [196, 322, 504, 328] }] }] }] },
      { page_idx: 1, page_size: [544, 742], para_blocks: [{ type: 'text', bbox: [190, 300, 510, 350], lines_deleted: true, lines: [] }] }
    ] }
    expect(findTextLayerCandidates(layout).map((candidate) => candidate.pageIndex)).toEqual([1])
  })

  it('rebuilds spurious scripts and dropped letters from the layer geometry, keeping real scripts', () => {
    const noisy = 'Machine Learnin<sub>g</sub> methods belon<sub>g</sub> to the <sub>g</sub>rou<sub>p</sub>'
    const spans = [
      { content: 'St<sub>e</sub>f<sub>an</sub> Hild<sub>e</sub>b<sub>ran</sub>d<sup>*</sup> <sub>an</sub>d S<sub>an</sub>d<sub>ra</sub>', box: [47, 126, 201, 138] },
      { content: 'a nonlinear o erator on the domain', box: [47, 146, 449, 156] },
      { content: '<sub>.</sub> Th<sub>e</sub>', box: [200, 166, 260, 176] },
      ...Array.from({ length: 8 }, (_, index) => ({ content: noisy, box: [47, 186 + index * 20, 449, 196 + index * 20] }))
    ]
    const layout = { pdf_info: [{ page_idx: 0, page_size: [498, 708], para_blocks: spans.map((span) => ({
      type: 'text', bbox: span.box, lines: [{ bbox: span.box, spans: [{ type: 'text', content: span.content, bbox: span.box }] }]
    })) }] }
    const candidates = findTextLayerCandidates(layout)
    expect(candidates.every((candidate) => candidate.kind === 'compare')).toBe(true)
    // Without enough glued scripts the document is left alone.
    expect(findTextLayerCandidates({ pdf_info: [{ ...layout.pdf_info[0], para_blocks: layout.pdf_info[0]!.para_blocks.slice(0, 5) }] })).toEqual([])

    const item = (text: string, x: number, baseline: number, height = 10): TextLayerItem => ({ text, bbox: [x, baseline - 0.8 * height, x + text.length * 4.5, baseline + 0.2 * height] })
    const items = [
      item('Stefan Hildebrand', 48, 135.2), item('*', 121.9, 131.6, 7.3), item('and Sandra', 127.5, 135.2),
      item('a nonlinear operator on the domain', 48, 154),
      // An equation's own superscript `n` caught by the box of the following text span.
      item('n', 201, 170, 7), item('. The', 206, 174),
      ...Array.from({ length: 8 }, (_, index) => item('Machine Learning methods belong to the group', 48, 194 + index * 20))
    ]
    const report = planTextLayerRepairs(candidates, [{ pageIndex: 0, items }])
    const byOriginal = new Map(report.repairs.map((repair) => [repair.original, repair.replacement]))
    expect(byOriginal.get(spans[0]!.content)).toBe('Stefan Hildebrand<sup>*</sup> and Sandra')
    expect(byOriginal.get(spans[1]!.content)).toBe('a nonlinear operator on the domain')
    expect(byOriginal.get(spans[2]!.content)).toBe('. The')
    expect(byOriginal.get(noisy)).toBe('Machine Learning methods belong to the group')
    expect(report.unresolved).toEqual([])

    // MinerU writes `*` escaped; a real script stays HTML in the patched Markdown.
    const markdown = `${spans[0]!.content.replace('*', '\\*')}\n\n$x^{n}$ ${spans[2]!.content}\n`
    const applied = applyTextLayerRepairs(layout, markdown, { ...report, repairs: report.repairs.filter((repair) => repair.original !== noisy) })
    expect(applied.markdown).toContain('Stefan Hildebrand<sup>\\*</sup> and Sandra\n')
    expect(applied.markdown).toContain('$x^{n}$ . The\n')
  })
})
