import type { ReaderAnnotationView } from '@features/reader/contract/readerTypes'
import type { PdfViewState } from './components/PdfPane'

/** Where a paper is being read: outside the panes, so a moved or reopened view resumes there. */
export interface ReaderPositions {
  scroll: Record<ReaderAnnotationView, number>
  pdf: PdfViewState | null
}

export function freshReaderPositions(): ReaderPositions {
  return { scroll: { original: 0, translated: 0 }, pdf: null }
}

const SESSION_LIMIT = 128
const session = new Map<string, ReaderPositions>()

/** A paper's positions for this session, so switching to another paper and back loses nothing. Not saved to disk. */
export function sessionReaderPositions(documentId: string): ReaderPositions {
  const positions = session.get(documentId) ?? freshReaderPositions()
  session.delete(documentId)
  session.set(documentId, positions)
  if (session.size > SESSION_LIMIT) session.delete(session.keys().next().value!)
  return positions
}
