import type { DocumentAnnotation } from '@shared/ipcSchemas'

export interface AnnotationDiff {
  upserts: DocumentAnnotation[]
  deleteIds: string[]
}

/** Compute an O(changes) mutation from one annotation snapshot to the next. */
export function buildAnnotationDiff(
  previous: readonly DocumentAnnotation[],
  next: readonly DocumentAnnotation[]
): AnnotationDiff {
  const previousById = new Map(previous.map((annotation) => [annotation.id, annotation] as const))
  const nextById = new Map(next.map((annotation) => [annotation.id, annotation] as const))
  const upserts = next.filter((annotation) => !sameAnnotation(previousById.get(annotation.id), annotation))
  const deleteIds = previous
    .filter((annotation) => !nextById.has(annotation.id))
    .map((annotation) => annotation.id)
  return { upserts, deleteIds }
}

/**
 * Rebase one user diff over a newer server snapshot without overwriting a
 * concurrent edit to the same annotation ID.  New IDs and unchanged base
 * rows are replayed; conflicting server rows win.
 */
export function replayAnnotationDiff(
  base: readonly DocumentAnnotation[],
  latest: readonly DocumentAnnotation[],
  diff: AnnotationDiff
): AnnotationDiff {
  const baseById = new Map(base.map((annotation) => [annotation.id, annotation] as const))
  const latestById = new Map(latest.map((annotation) => [annotation.id, annotation] as const))
  const upserts = diff.upserts.filter((annotation) => {
    const server = latestById.get(annotation.id)
    const baseValue = baseById.get(annotation.id)
    return baseValue === undefined ? server === undefined : server !== undefined && sameAnnotation(server, baseValue)
  })
  const deleteIds = diff.deleteIds.filter((id) => {
    const server = latestById.get(id)
    const baseValue = baseById.get(id)
    return server !== undefined && sameAnnotation(server, baseValue)
  })
  return { upserts, deleteIds }
}

function sameAnnotation(left: DocumentAnnotation | undefined, right: DocumentAnnotation | undefined): boolean {
  return left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right)
}
