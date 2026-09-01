import { describe, expect, it } from 'vitest'
import {
  applyReaderAnnotationOperation,
  resolveReaderAnnotation,
  type ReaderAnnotationSelectionFragment
} from '@shared/readerAnnotations'
import type { HighlightColor, ReaderAnnotation, ReaderAnnotationKind } from '@shared/types'

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
