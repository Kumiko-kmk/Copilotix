import React from 'react'
import type { FigureDisplayChoice } from '@shared/figureDisplay'
import type { ReaderFigureGroup } from '@shared/readerFigureGroups'

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

/**
 * Applies the reader's choice on top of the automatic grouping: "pdf" shows the PDF crop even when
 * the panels could not be confirmed, "parsed" shows the parsed panels of a confirmed figure. The
 * automatic status is kept so choosing it again clears the override.
 */
export function applyFigureDisplay(groups: readonly ReaderFigureGroup[], documentId: string, choices: Choices): ReaderFigureGroup[] {
  return groups.map((group) => {
    const choice = choices[group.id] ?? null
    const display = { documentId, automatic: group.status, choice }
    if (choice === 'pdf' && group.status !== 'complete') return { ...group, status: 'complete', reason: '已选择以 PDF 原图显示', display }
    if (choice === 'parsed' && group.status === 'complete') return { ...group, status: 'ambiguous', reason: '已选择以解析子图显示', display }
    return { ...group, display }
  })
}
