import type {
  HighlightColor,
  ReaderAnnotation,
  ReaderAnnotationKind,
  ReaderAnnotationView
} from './types'

export const READER_HIGHLIGHT_COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink', 'purple']

export interface ReaderAnnotationSelectionFragment {
  blockKey: string
  startOffset: number
  endOffset: number
}

export interface ResolvedReaderAnnotation {
  annotation: ReaderAnnotation
  startOffset: number
  endOffset: number
}

interface Interval {
  startOffset: number
  endOffset: number
  color: HighlightColor | null
}

export function resolveReaderAnnotation(text: string, annotation: ReaderAnnotation): ResolvedReaderAnnotation | null {
  if (
    annotation.startOffset >= 0 &&
    annotation.endOffset <= text.length &&
    text.slice(annotation.startOffset, annotation.endOffset) === annotation.quote
  ) {
    return { annotation, startOffset: annotation.startOffset, endOffset: annotation.endOffset }
  }

  const candidates: Array<{ startOffset: number; contextScore: number; distance: number }> = []
  let cursor = 0
  while (cursor <= text.length - annotation.quote.length) {
    const startOffset = text.indexOf(annotation.quote, cursor)
    if (startOffset < 0) break
    const endOffset = startOffset + annotation.quote.length
    candidates.push({
      startOffset,
      contextScore:
        matchingSuffixLength(text.slice(Math.max(0, startOffset - 32), startOffset), annotation.prefix) +
        matchingPrefixLength(text.slice(endOffset, endOffset + 32), annotation.suffix),
      distance: Math.abs(startOffset - annotation.startOffset)
    })
    cursor = startOffset + 1
  }
  if (candidates.length === 0) return null
  candidates.sort((left, right) => right.contextScore - left.contextScore || left.distance - right.distance)
  const best = candidates[0]!
  const second = candidates[1]
  if (second && second.contextScore === best.contextScore && second.distance === best.distance) return null
  return {
    annotation,
    startOffset: best.startOffset,
    endOffset: best.startOffset + annotation.quote.length
  }
}

export function applyReaderAnnotationOperation(input: {
  existing: ReaderAnnotation[]
  taskId: string
  view: ReaderAnnotationView
  kind: ReaderAnnotationKind
  color: HighlightColor | null
  selections: ReaderAnnotationSelectionFragment[]
  blockTexts: ReadonlyMap<string, string>
  now?: string
  createId(): string
}): ReaderAnnotation[] {
  const selectionsByBlock = groupSelections(input.selections)
  if (selectionsByBlock.size === 0) return input.existing
  const expectedColor = input.kind === 'highlight' ? input.color : null
  const target = input.existing.filter((annotation) => annotation.kind === input.kind)
  const otherKind = input.existing.filter((annotation) => annotation.kind !== input.kind)
  const removeMode = [...selectionsByBlock].every(([blockKey, selections]) => {
    const intervals = target
      .filter((annotation) => annotation.blockKey === blockKey && annotation.color === expectedColor)
      .map(toInterval)
    return selections.every((selection) => intervalIsCovered(selection, intervals))
  })
  const unaffected = target.filter((annotation) => !selectionsByBlock.has(annotation.blockKey))
  const changed: ReaderAnnotation[] = []
  const now = input.now ?? new Date().toISOString()

  for (const [blockKey, selections] of selectionsByBlock) {
    const text = input.blockTexts.get(blockKey)
    if (text === undefined) continue
    let intervals = target
      .filter((annotation) => annotation.blockKey === blockKey)
      .map(toInterval)
    intervals = subtractIntervals(intervals, selections)
    if (!removeMode) {
      intervals.push(...selections.map((selection) => ({ ...selection, color: expectedColor })))
    }
    for (const interval of mergeIntervals(intervals)) {
      if (interval.startOffset < 0 || interval.endOffset > text.length || interval.endOffset <= interval.startOffset) continue
      changed.push(createAnnotation({
        taskId: input.taskId,
        view: input.view,
        kind: input.kind,
        color: interval.color,
        blockKey,
        startOffset: interval.startOffset,
        endOffset: interval.endOffset,
        text,
        now,
        id: input.createId()
      }))
    }
  }

  return [...otherKind, ...unaffected, ...changed].sort(compareAnnotations)
}

function createAnnotation(input: {
  id: string
  taskId: string
  view: ReaderAnnotationView
  kind: ReaderAnnotationKind
  color: HighlightColor | null
  blockKey: string
  startOffset: number
  endOffset: number
  text: string
  now: string
}): ReaderAnnotation {
  return {
    id: input.id,
    taskId: input.taskId,
    view: input.view,
    kind: input.kind,
    color: input.kind === 'highlight' ? input.color : null,
    blockKey: input.blockKey,
    startOffset: input.startOffset,
    endOffset: input.endOffset,
    quote: input.text.slice(input.startOffset, input.endOffset),
    prefix: input.text.slice(Math.max(0, input.startOffset - 32), input.startOffset),
    suffix: input.text.slice(input.endOffset, input.endOffset + 32),
    createdAt: input.now,
    updatedAt: input.now
  }
}

function groupSelections(
  selections: ReaderAnnotationSelectionFragment[]
): Map<string, ReaderAnnotationSelectionFragment[]> {
  const result = new Map<string, ReaderAnnotationSelectionFragment[]>()
  for (const selection of selections) {
    if (!selection.blockKey || selection.endOffset <= selection.startOffset) continue
    const current = result.get(selection.blockKey) ?? []
    current.push({ ...selection })
    result.set(selection.blockKey, current)
  }
  for (const [blockKey, values] of result) {
    const merged: ReaderAnnotationSelectionFragment[] = []
    for (const value of values.sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset)) {
      const previous = merged.at(-1)
      if (previous && value.startOffset <= previous.endOffset) previous.endOffset = Math.max(previous.endOffset, value.endOffset)
      else merged.push({ ...value })
    }
    result.set(blockKey, merged)
  }
  return result
}

function intervalIsCovered(selection: ReaderAnnotationSelectionFragment, intervals: Interval[]): boolean {
  let cursor = selection.startOffset
  for (const interval of intervals.sort((left, right) => left.startOffset - right.startOffset)) {
    if (interval.endOffset <= cursor) continue
    if (interval.startOffset > cursor) return false
    cursor = Math.max(cursor, interval.endOffset)
    if (cursor >= selection.endOffset) return true
  }
  return false
}

function subtractIntervals(intervals: Interval[], selections: ReaderAnnotationSelectionFragment[]): Interval[] {
  let result = intervals
  for (const selection of selections) {
    result = result.flatMap((interval) => {
      if (selection.endOffset <= interval.startOffset || selection.startOffset >= interval.endOffset) return [interval]
      const pieces: Interval[] = []
      if (selection.startOffset > interval.startOffset) {
        pieces.push({ ...interval, endOffset: selection.startOffset })
      }
      if (selection.endOffset < interval.endOffset) {
        pieces.push({ ...interval, startOffset: selection.endOffset })
      }
      return pieces
    })
  }
  return result
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const result: Interval[] = []
  for (const interval of intervals.sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset)) {
    const previous = result.at(-1)
    if (previous && previous.color === interval.color && interval.startOffset <= previous.endOffset) {
      previous.endOffset = Math.max(previous.endOffset, interval.endOffset)
    } else {
      result.push({ ...interval })
    }
  }
  return result
}

function toInterval(annotation: ReaderAnnotation): Interval {
  return {
    startOffset: annotation.startOffset,
    endOffset: annotation.endOffset,
    color: annotation.color
  }
}

function compareAnnotations(left: ReaderAnnotation, right: ReaderAnnotation): number {
  return left.view.localeCompare(right.view) || left.blockKey.localeCompare(right.blockKey) ||
    left.startOffset - right.startOffset || left.endOffset - right.endOffset || left.kind.localeCompare(right.kind)
}

function matchingPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length)
  let matched = 0
  while (matched < length && left[matched] === right[matched]) matched += 1
  return matched
}

function matchingSuffixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length)
  let matched = 0
  while (matched < length && left[left.length - 1 - matched] === right[right.length - 1 - matched]) matched += 1
  return matched
}
