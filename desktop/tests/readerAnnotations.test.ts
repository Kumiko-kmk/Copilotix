import { describe, expect, it } from 'vitest'
import { applyReaderAnnotationOperation, resolveReaderAnnotation, type ReaderAnnotationSelectionFragment } from '../src/shared/readerAnnotations'
import { type HighlightColor, type ReaderAnnotation, type ReaderAnnotationKind } from '../src/shared/types'
import { type DocumentAnnotation } from '../src/shared/ipcSchemas'
import { buildAnnotationDiff, replayAnnotationDiff } from '../src/renderer/annotationMutations'
import { readerReferenceSections } from '../src/renderer/readerReferenceSections'
import { type ReaderBlock } from '../src/shared/readerDocument'

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
