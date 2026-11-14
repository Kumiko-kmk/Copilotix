import React from 'react'
import type { FigureDisplayChoice } from '../contract/figureDisplay'
import type { ReaderFigureGroup } from '../core/readerFigureGroups'

type Choices = Readonly<Record<string, FigureDisplayChoice>>
const EMPTY: Choices = Object.freeze({})
const cache = new Map<string, Choices>()
const loading = new Set<string>()
const listeners = new Set<() => void>()
const notify = (): void => { for (const listener of listeners) listener() }

/** The reader's remembered PDF-crop / parsed-panel choices for one paper (empty until loaded). */
export function useFigureDisplayChoices(documentId: string): Choices {
  const choices = React.useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => cache.get(documentId) ?? EMPTY
  )
  React.useEffect(() => {
    const api = window.copilotix?.figureDisplay
    if (!api || cache.has(documentId) || loading.has(documentId)) return
    loading.add(documentId)
    void api.get({ documentId })
      .then((result) => { cache.set(documentId, result.choices); notify() })
      .catch(() => undefined)
      .finally(() => loading.delete(documentId))
  }, [documentId])
  return choices
}

export async function setFigureDisplayChoice(documentId: string, figureId: string, choice: FigureDisplayChoice | null): Promise<void> {
  const result = await window.copilotix.figureDisplay.set({ documentId, figureId, choice })
  cache.set(documentId, result.choices)
  notify()
}

/** What a figure shows without a stored choice: its PDF crop wherever one can be cut. */
export function automaticFigureDisplay(status: ReaderFigureGroup['status']): FigureDisplayChoice {
  return status === 'unsupported' ? 'parsed' : 'pdf'
}

/**
 * Applies the reader's choice on top of the automatic grouping. Figures show their PDF crop by
 * default, also when the panels could not be confirmed; "parsed" shows the parsed panels instead and
 * "pdf" forces the crop of a figure without a caption. Choosing the automatic display clears the choice.
 */
export function applyFigureDisplay(groups: readonly ReaderFigureGroup[], documentId: string, choices: Choices): ReaderFigureGroup[] {
  return groups.map((group) => {
    const choice = choices[group.id] ?? null
    const display = { documentId, automatic: group.status, choice }
    const shown = choice ?? automaticFigureDisplay(group.status)
    if (shown === 'pdf' && group.status !== 'complete') return { ...group, status: 'complete', reason: choice ? '已选择以 PDF 原图显示' : '默认以 PDF 原图显示', display }
    if (shown === 'parsed' && group.status === 'complete') return { ...group, status: 'ambiguous', reason: '已选择以解析子图显示', display }
    return { ...group, display }
  })
}
