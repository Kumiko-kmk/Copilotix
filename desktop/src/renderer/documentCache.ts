import type { DocumentChangeEvent, DocumentDetails, DocumentSummary } from '@shared/ipcSchemas'

export interface DocumentListCache {
  revision: number
  documents: DocumentSummary[]
}

export interface DocumentRefreshPlan {
  invalidateDocument: boolean
  annotationViews: Array<'original' | 'translated'>
}

/** Apply only the changed rows; stale/replayed revisions are ignored. */
export function applyDocumentChange(
  current: DocumentListCache,
  change: DocumentChangeEvent
): DocumentListCache {
  if (change.revision <= current.revision) return current
  const documentsById = new Map(current.documents.map((document) => [document.id, document] as const))
  for (const document of change.upserted) documentsById.set(document.id, document)
  for (const documentId of change.removedIds) documentsById.delete(documentId)
  return {
    revision: change.revision,
    documents: [...documentsById.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)
    )
  }
}

/**
 * Decide which content queries need a refresh for a workflow transition.
 * Progress-only events intentionally return an empty plan so a long-running
 * parse/translation does not repeatedly reload large Markdown artifacts.
 */
export function getDocumentRefreshPlan(
  previous: DocumentSummary | undefined,
  next: DocumentSummary
): DocumentRefreshPlan {
  if (!previous) return { invalidateDocument: false, annotationViews: [] }
  const workflowChanged = previous.workflow.status !== next.workflow.status ||
    previous.workflow.activeJobKind !== next.workflow.activeJobKind
  if (!workflowChanged) return { invalidateDocument: false, annotationViews: [] }
  if (next.workflow.status === 'translating') {
    return { invalidateDocument: true, annotationViews: ['original'] }
  }
  if (isTerminalStatus(next.workflow.status)) {
    return { invalidateDocument: true, annotationViews: ['original', 'translated'] }
  }
  return { invalidateDocument: true, annotationViews: [] }
}

export function patchDocumentDetails(
  current: DocumentDetails | undefined,
  change: DocumentChangeEvent
): DocumentDetails | undefined {
  if (!current) return current
  if (change.removedIds.includes(current.summary.id)) return undefined
  const summary = change.upserted.find((document) => document.id === current.summary.id)
  return summary ? { ...current, summary } : current
}

function isTerminalStatus(status: DocumentSummary['workflow']['status']): boolean {
  return status === 'partial' || status === 'completed' || status === 'failed'
}
