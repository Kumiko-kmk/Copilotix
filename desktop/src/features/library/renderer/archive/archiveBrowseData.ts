import type { DocumentDetails } from '../../contract/documentSchemas'
import type { ArchivePaper } from './archiveShelves'

const documentRequests = new Map<string, Promise<DocumentDetails>>()

export function archivePaperRevision(paper: ArchivePaper): string {
  return `${paper.updatedAt ?? paper.createdAt}:${paper.workflow.status}`
}

/** Cover preparation and the open detail share overlapping local reads, without retaining full bodies. */
export function loadArchiveDocument(documentId: string, revision: string): Promise<DocumentDetails> {
  const key = `${documentId}:${revision}`
  const pending = documentRequests.get(key)
  if (pending) return pending
  const request = window.copilotix.getDocument(documentId)
  documentRequests.set(key, request)
  const clear = (): void => { if (documentRequests.get(key) === request) documentRequests.delete(key) }
  void request.then(clear, clear)
  return request
}
