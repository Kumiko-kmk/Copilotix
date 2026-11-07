import { loadDocumentBase } from '@features/document/renderer'
import type { DocumentDetails } from '@features/library/contract/documentSchemas'

/**
 * One paper's reader payload (several MB). It never goes stale on a timer: document change events
 * invalidate it when the paper really changes, so reopening a paper reuses it instead of fetching and
 * rebuilding everything again. Comparing the old and new payload field by field would cost more than
 * it saves, so a refetch simply replaces it.
 */
export function readerDocumentQuery(documentId: string) {
  return {
    queryKey: ['document', documentId] as const,
    queryFn: (): Promise<DocumentDetails> => window.copilotix.getDocument(documentId).then(loadDocumentBase),
    staleTime: Infinity,
    structuralSharing: false
  }
}
