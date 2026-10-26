import React from 'react'
import type { ReaderBlock } from '../../core/readerDocument'
import { figureAssetName, markdownAssetSources, type ReaderFigureGroup } from '../../core/readerFigureGroups'
import { figureMosaic, type FigureMosaic } from '../readerFigureMosaic'
import type { FigureRenderState } from './ReaderFigureSnapshot'

/**
 * Figure groups of a Markdown view per block, their PDF crop states and the
 * side-by-side mosaics shown while a crop is missing (MarkdownPane).
 */
export function useMarkdownFigures(blocks: ReaderBlock[], figureGroups: ReaderFigureGroup[] | undefined, pdfUrl: string | undefined) {
  // Per-block group lists keep their identity while their groups do, so memoized blocks stay put.
  const previousGroupsRef = React.useRef(new Map<number, ReaderFigureGroup[]>())
  const figureGroupByBlockIndex = React.useMemo(() => {
    const result = new Map<number, ReaderFigureGroup[]>()
    for (const group of figureGroups ?? []) {
      for (const index of group.memberBlockIndexes) result.set(index, [...(result.get(index) ?? []), group])
    }
    for (const [index, groups] of result) {
      const previous = previousGroupsRef.current.get(index)
      if (previous && previous.length === groups.length && previous.every((group, i) => group === groups[i])) result.set(index, previous)
    }
    previousGroupsRef.current = result
    return result
  }, [figureGroups])
  // Keyed by the figures themselves: editing or deleting a paragraph must not send every crop back to
  // "pending" (their placeholders collapse and the page loses its reading position).
  const figureRevision = React.useMemo(() => (figureGroups ?? [])
    .map(group => group.id + ':' + group.cropBox.join(',')).join('|') + '|' + pdfUrl, [figureGroups, pdfUrl])
  const [figureStates, setFigureStates] = React.useState<{ revision: string; states: Record<string, FigureRenderState> }>({ revision: figureRevision, states: {} })
  const readyFigureKey = figureStates.revision === figureRevision
    ? Object.keys(figureStates.states).filter(id => figureStates.states[id] === 'ready').sort().join('\0') : ''
  const readyFigureIds = React.useMemo(() => new Set(readyFigureKey ? readyFigureKey.split('\0') : []), [readyFigureKey])
  const failedFigureKey = figureStates.revision === figureRevision
    ? Object.keys(figureStates.states).filter(id => figureStates.states[id] === 'failed').sort().join('\0') : ''
  // A figure without a PDF crop (unconfirmed, or its crop failed) keeps side-by-side panels
  // where the PDF puts them instead of one image per line (readerFigureMosaic.ts).
  const figureMosaics = React.useMemo(() => {
    const failed = new Set(failedFigureKey ? failedFigureKey.split('\0') : [])
    const groups = figureGroups ?? []
    const result = new Map<string, FigureMosaic>()
    for (const group of groups) {
      if (group.status === 'complete' && !failed.has(group.id)) continue
      // A panel claimed by two figures is shown once, in its own paragraph.
      const names = new Set(group.assetSources.map(figureAssetName))
      if (groups.some(other => other !== group && other.assetSources.some(asset => names.has(figureAssetName(asset))))) continue
      const mosaic = figureMosaic(group, group.memberBlockIndexes.flatMap(index => markdownAssetSources(blocks[index]?.markdown ?? '')))
      if (mosaic) result.set(group.id, mosaic)
    }
    return result
  }, [figureGroups, blocks, failedFigureKey])
  const minimapVisualRevision = React.useMemo(() => JSON.stringify([
    figureRevision, [...readyFigureIds], [...figureMosaics.keys()]
  ]), [figureRevision, readyFigureIds, figureMosaics])
  const figuresSettled = !pdfUrl || Array.from(figureGroupByBlockIndex.entries()).every(([index, groups]) => groups.every(group =>
    group.status !== 'complete' || group.ownerBlockIndex !== index || blocks[index]?.role !== 'content' ||
    (figureStates.revision === figureRevision &&
      (figureStates.states[group.id] === 'ready' || figureStates.states[group.id] === 'failed'))
  ))
  const setFigureState = React.useCallback((id: string, state: FigureRenderState) => {
    setFigureStates(previous => {
      const states = previous.revision === figureRevision ? previous.states : {}
      return states[id] === state && previous.revision === figureRevision ? previous : { revision: figureRevision, states: { ...states, [id]: state } }
    })
  }, [figureRevision])
  return { figureGroupByBlockIndex, figureStates, readyFigureIds, figureMosaics, minimapVisualRevision, figuresSettled, setFigureState }
}

/** Reorder units of a Markdown view: a figure moves as one block (its images, panels and caption paragraphs). */
export function useReorderUnits(blocks: ReaderBlock[], figureGroupByBlockIndex: ReadonlyMap<number, ReaderFigureGroup[]>) {
  const reorderUnitOf = React.useCallback((index: number): number[] | null => {
    if (blocks[index]?.role !== 'content') return null
    const unit = new Set([index])
    for (let changed = true; changed;) {
      changed = false
      for (const member of [...unit]) for (const group of figureGroupByBlockIndex.get(member) ?? []) {
        for (const next of [...group.memberBlockIndexes, group.captionBlockIndex]) {
          if (next >= 0 && !unit.has(next) && blocks[next]?.role === 'content') { unit.add(next); changed = true }
        }
      }
    }
    return [...unit].sort((a, b) => a - b)
  }, [figureGroupByBlockIndex, blocks])
  const contentIndexOf = React.useCallback((index: number) => blocks[index]?.role === 'content' ? blocks[index]!.contentIndex : undefined, [blocks])
  /** Neighbouring units in reading order, for the menu's move up / move down. */
  const reorderNeighbours = (index: number): { unit: number[]; up?: number; down?: number | null } | null => {
    const unit = reorderUnitOf(index)
    if (!unit) return null
    const order: number[][] = []
    const seen = new Set<number>()
    blocks.forEach((block, at) => {
      if (block.role !== 'content' || seen.has(at)) return
      const members = reorderUnitOf(at) ?? [at]
      members.forEach(member => seen.add(member))
      order.push(members)
    })
    const position = order.findIndex(members => members.includes(unit[0]!))
    const first = (members: number[] | undefined): number | undefined => members ? contentIndexOf(members[0]!) : undefined
    return { unit, up: position > 0 ? first(order[position - 1]) : undefined,
      down: position >= 0 && position < order.length - 1 ? (position + 2 < order.length ? first(order[position + 2]) ?? null : null) : undefined }
  }
  return { reorderUnitOf, contentIndexOf, reorderNeighbours }
}
