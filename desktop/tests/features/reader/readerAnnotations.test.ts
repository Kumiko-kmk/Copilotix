import { describe, expect, it } from 'vitest'
import { applyReaderAnnotationOperation, resolveReaderAnnotation, type ReaderAnnotationSelectionFragment } from '../../../src/features/reader/core/readerAnnotations'
import { type HighlightColor, type ReaderAnnotation, type ReaderAnnotationKind } from '../../../src/features/reader/contract/readerTypes'
import { type DocumentAnnotation } from '../../../src/features/reader/contract/readerSchemas'
import { buildAnnotationDiff, replayAnnotationDiff } from '../../../src/features/reader/renderer/annotationMutations'
import { readerReferenceSections } from '../../../src/features/reader/renderer/readerReferenceSections'
import { buildCitationIndex, counterpartEntry, findCitations, looksLikeAuthorLine, superscriptCitation } from '../../../src/features/reader/renderer/readerCitations'
import { type ReaderBlock } from '../../../src/features/reader/core/readerDocument'

describe("readerAnnotations", () => {
  describe('reader annotation intervals', () => {
    it('adds, splits, recolors and removes exact highlight intervals', () => {
      const text = 'abcdefghij'
      let id = 0
      let annotations: ReaderAnnotation[] = []
      annotations = apply(annotations, 'highlight', 'yellow', [{ blockKey: 'content:0', startOffset: 2, endOffset: 8 }], text, () => `id-${++id}`)
      expect(summary(annotations)).toEqual([['highlight', 'yellow', 2, 8, 'cdefgh']])

      annotations = apply(annotations, 'highlight', 'yellow', [{ blockKey: 'content:0', startOffset: 4, endOffset: 6 }], text, () => `id-${++id}`)
      expect(summary(annotations)).toEqual([
        ['highlight', 'yellow', 2, 4, 'cd'],
        ['highlight', 'yellow', 6, 8, 'gh']
      ])

      annotations = apply(annotations, 'highlight', 'blue', [{ blockKey: 'content:0', startOffset: 3, endOffset: 7 }], text, () => `id-${++id}`)
      expect(summary(annotations)).toEqual([
        ['highlight', 'yellow', 2, 3, 'c'],
        ['highlight', 'blue', 3, 7, 'defg'],
        ['highlight', 'yellow', 7, 8, 'h']
      ])
    })

    it('keeps underline independent and applies a cross-block operation atomically', () => {
      const texts = new Map([['content:0', 'alpha'], ['content:1', 'bravo']])
      let id = 0
      const selections = [
        { blockKey: 'content:0', startOffset: 1, endOffset: 5 },
        { blockKey: 'content:1', startOffset: 0, endOffset: 3 }
      ]
      let annotations = applyReaderAnnotationOperation({
        existing: [], taskId: 'task', view: 'translated', kind: 'underline', color: null,
        selections, blockTexts: texts, createId: () => `id-${++id}`
      })
      annotations = applyReaderAnnotationOperation({
        existing: annotations, taskId: 'task', view: 'translated', kind: 'highlight', color: 'green',
        selections, blockTexts: texts, createId: () => `id-${++id}`
      })
      expect(annotations.filter((value) => value.kind === 'underline')).toHaveLength(2)
      expect(annotations.filter((value) => value.kind === 'highlight')).toHaveLength(2)

      annotations = applyReaderAnnotationOperation({
        existing: annotations, taskId: 'task', view: 'translated', kind: 'underline', color: null,
        selections, blockTexts: texts, createId: () => `id-${++id}`
      })
      expect(annotations.every((value) => value.kind === 'highlight')).toBe(true)
    })

    it('reanchors a quote with context and refuses an indistinguishable tie', () => {
      const annotation = storedAnnotation({
        startOffset: 6,
        endOffset: 10,
        quote: 'beta',
        prefix: 'alpha ',
        suffix: ' gamma'
      })
      expect(resolveReaderAnnotation('prefix alpha beta gamma', annotation)).toMatchObject({
        startOffset: 13,
        endOffset: 17
      })
      expect(resolveReaderAnnotation('beta xx beta', {
        ...annotation,
        startOffset: 4,
        endOffset: 8,
        prefix: '',
        suffix: ''
      })).toBeNull()
    })
  })

  function apply(
    existing: ReaderAnnotation[],
    kind: ReaderAnnotationKind,
    color: HighlightColor | null,
    selections: ReaderAnnotationSelectionFragment[],
    text: string,
    createId: () => string
  ): ReaderAnnotation[] {
    return applyReaderAnnotationOperation({
      existing,
      taskId: 'task',
      view: 'original',
      kind,
      color,
      selections,
      blockTexts: new Map([['content:0', text]]),
      now: '2026-01-01T00:00:00.000Z',
      createId
    })
  }

  function summary(values: ReaderAnnotation[]): Array<[string, string | null, number, number, string]> {
    return values.map((value) => [value.kind, value.color, value.startOffset, value.endOffset, value.quote])
  }

  function storedAnnotation(patch: Partial<ReaderAnnotation>): ReaderAnnotation {
    return {
      id: 'annotation', taskId: 'task', view: 'original', kind: 'highlight', color: 'yellow',
      blockKey: 'content:0', startOffset: 0, endOffset: 1, quote: 'a', prefix: '', suffix: '',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...patch
    }
  }
})

describe("annotationMutations", () => {
  const base: DocumentAnnotation = {
    id: '33333333-3333-4333-8333-333333333333',
    documentId: '11111111-1111-4111-8111-111111111111',
    artifactId: '22222222-2222-4222-8222-222222222222',
    view: 'original',
    kind: 'highlight',
    color: 'yellow',
    blockKey: 'content:0',
    startOffset: 0,
    endOffset: 5,
    quote: 'alpha',
    prefix: '',
    suffix: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
  const created: DocumentAnnotation = { ...base, id: '44444444-4444-4444-8444-444444444444', startOffset: 6, endOffset: 10, quote: 'beta' }

  describe('annotation mutation/replay helpers', () => {
    it('sends only changed upserts and deletes', () => {
      const diff = buildAnnotationDiff([base], [{ ...base, quote: 'ALPHA' }, created])
      expect(diff.upserts.map((annotation) => annotation.id)).toEqual([base.id, created.id])
      expect(diff.deleteIds).toEqual([])
      expect(buildAnnotationDiff([base, created], [base])).toEqual({ upserts: [], deleteIds: [created.id] })
    })

    it('replays local changes once while server wins concurrent edits and deletes', () => {
      const local = { ...base, quote: 'ALPHA' }
      const diff = buildAnnotationDiff([base], [local])
      const concurrentEdit = { ...base, quote: 'SERVER' }
      expect(replayAnnotationDiff([base], [concurrentEdit], diff)).toEqual({ upserts: [], deleteIds: [] })
      expect(replayAnnotationDiff([base], [], diff)).toEqual({ upserts: [], deleteIds: [] })
      expect(replayAnnotationDiff([base], [base], diff)).toEqual(diff)
    })

    it('does not recreate a row deleted concurrently, but replays a genuinely new row', () => {
      const localEdit = { ...base, quote: 'ALPHA' }
      const existingRowDiff = buildAnnotationDiff([base], [localEdit])
      expect(replayAnnotationDiff([base], [], existingRowDiff)).toEqual({ upserts: [], deleteIds: [] })

      const newRowDiff = buildAnnotationDiff([], [created])
      expect(replayAnnotationDiff([], [], newRowDiff)).toEqual(newRowDiff)
      expect(replayAnnotationDiff([], [created], newRowDiff)).toEqual({ upserts: [], deleteIds: [] })
    })
  })
})

describe("readerReferenceSections", () => {
  const block = (markdown: string): ReaderBlock => ({ role: 'content', markdown, mappingIds: [], order: 0 })

  describe('reference section typography', () => {
    it('follows numbered reference headings through page boundaries and stops at an appendix', () => {
      const blocks: ReaderBlock[] = [block('## Discussion'), block('Normal text.'), block('## 7. References'),
        block('[1] First reference.'), { role: 'page-divider', markdown: '', mappingIds: [], order: 0 },
        block('### Online sources'), block('[2] Second reference.'), block('## Appendix'), block('Appendix text.')]
      expect([...readerReferenceSections(blocks)]).toEqual([2, 3, 5, 6])
    })
    it('recognizes Chinese headings without shrinking ordinary mentions of references', () => {
      expect([...readerReferenceSections([block('References are discussed here.'), block('## 參考文獻'), block('文献条目。')])]).toEqual([1, 2])
    })
  })
})

describe('readerCitations', () => {
  const block = (markdown: string): ReaderBlock => ({ role: 'content', markdown, mappingIds: [], order: 0 })
  const ids = (text: string, blocks: ReaderBlock[]) => findCitations(text, buildCitationIndex(blocks)).map(match => [text.slice(match.start, match.end), match.entries.map(entry => entry.id), match.missing])

  it('resolves bracket citations, ranges and lists against a numbered list, split or merged by the parser', () => {
    const blocks = [block('Body text.'), block('## References'), block('\\[1] Liu WK. Eighty years of FEM. 2022.'),
      block('[2] Peng GC. Multiscale modelling. 2021. [3] Bishara D. A review. 2023.'), block('[4] Karniadakis GE. Physics-informed'),
      block('machine learning. 2021.'), block('[6] Cuomo S. PINNs. 2022.')]
    const index = buildCitationIndex(blocks)
    expect(index.entries.map(entry => [entry.id, entry.text])).toEqual([['n1', 'Liu WK. Eighty years of FEM. 2022.'], ['n2', 'Peng GC. Multiscale modelling. 2021.'],
      ['n3', 'Bishara D. A review. 2023.'], ['n4', 'Karniadakis GE. Physics-informed machine learning. 2021.'], ['n6', 'Cuomo S. PINNs. 2022.']])
    expect(ids('FEA [1], networks [2–4] and [1, 3] or ［6］.', blocks)).toEqual([['[1]', ['n1'], []], ['[2–4]', ['n2', 'n3', 'n4'], []], ['[1, 3]', ['n1', 'n3'], []], ['［6］', ['n6'], []]])
    // A gap in the list is reported, numbers past its end are no citation, and intervals stay text.
    expect(ids('[4-6] [7] [0, 1] x ∈ [1, 2]', blocks)).toEqual([['[4-6]', ['n4', 'n6'], [5]]])
    expect(index.referenceBlocks).toEqual(new Set([1, 2, 3, 4, 5, 6]))
  })

  it('finds a headless superscript-cited list and keeps affiliation numbers out', () => {
    const blocks = [block('# Deep learning'), block('Yann LeCun<sup>1,2</sup>, Yoshua Bengio<sup>3</sup> & Geoffrey Hinton<sup>4,5</sup>'),
      block('Deep learning improved image recognition<sup>1–3</sup> and the interval [1, 2].'), block('## Received 25 February 2015'),
      block('1. Krizhevsky, A., Sutskever, I. & Hinton, G. ImageNet classification. In Proc. NIPS (2012).\n\n2. Farabet, C. & LeCun, Y. Scene labeling. IEEE Trans. 35, 1915–1929 (2013).'),
      block('3. Tompson, J., Jain, A. & Bregler, C. Joint training of a convolutional network'), block('and a graphical model. In Proc. NIPS (2014).'),
      block('5. Mikolov, T. & Burget, L. Language models. In Proc. ASRU 196–201 (2011).\n\n4. Szegedy, C. et al. Going deeper. Preprint (2014).'),
      block('Methods text that is not a reference.')]
    const index = buildCitationIndex(blocks)
    expect(index.style).toBe('numeric')
    expect(index.superscripts).toBe(true)
    // Two-column pages may list entries out of order.
    expect(index.entries.map(entry => entry.number)).toEqual([1, 2, 3, 5, 4])
    expect(index.entries[2]!.text).toBe('Tompson, J., Jain, A. & Bregler, C. Joint training of a convolutional network and a graphical model. In Proc. NIPS (2014).')
    expect(superscriptCitation('1–3', index)?.entries.map(entry => entry.id)).toEqual(['n1', 'n2', 'n3'])
    expect(findCitations('the interval [1, 2]', index)).toEqual([])
    expect(looksLikeAuthorLine('Yann LeCun, Yoshua Bengio & Geoffrey Hinton')).toBe(true)
    expect(looksLikeAuthorLine('Deep learning improved image recognition')).toBe(false)
  })

  it('resolves author-year citations only when exactly one entry matches, in English and Chinese', () => {
    const blocks = [block('## References'), block('Ba, J. L., Kiros, J. R., and Hinton, G. E. Layer normalization. arXiv:1607.06450, 2016.'),
      block('Zongyi Li, Nikola Kovachki. Fourier neural operator. In ICLR, 2021a.'), block('Zongyi Li, Nikola Kovachki. Graph kernel network. 2021b.'),
      block('Bender, J. and Koschier, D. Divergence-free SPH. ACM, 2015.'), block('De Lorenzis, L. and Gerasimov, T. Phase-field. 2020.')]
    expect(ids('normalization (Ba et al., 2016; Li et al., 2021a), see Bender and Koschier (2015).', blocks))
      .toEqual([['Ba et al., 2016', ['a0'], []], ['Li et al., 2021a', ['a1'], []], ['Bender and Koschier (2015)', ['a3'], []]])
    // Ambiguous years, wrong co-authors and unknown names are left alone; particles stay in the marker.
    expect(ids('(Li et al., 2021) Bender and Smith (2015) Smith (2015) De Lorenzis et al. (2020)', blocks)).toEqual([['De Lorenzis et al. (2020)', ['a4'], []]])
    expect(ids('图网络（Ba等，2016；Li等人，2021b）以及 Bender 和 Koschier（2015）', blocks)).toEqual([['Ba等，2016', ['a0'], []], ['Li等人，2021b', ['a2'], []], ['Bender 和 Koschier（2015）', ['a3'], []]])
  })

  it('pairs an entry with the other view only when its text differs', () => {
    const original = buildCitationIndex([block('## References'), block('[1] Liu WK. Eighty years. 2022.'), block('[2] Peng GC. Multiscale. 2021.'), block('[3] Bishara D. Review. 2023.')])
    const translated = buildCitationIndex([block('## 参考文献'), block('[1] Liu WK. Eighty years. 2022.'), block('[2] Peng GC。多尺度建模。2021。'), block('[3] Bishara D. Review. 2023.')])
    expect(original.entries.map(entry => counterpartEntry(entry, original, translated)?.text ?? null)).toEqual([null, 'Peng GC。多尺度建模。2021。', null])
  })
})
