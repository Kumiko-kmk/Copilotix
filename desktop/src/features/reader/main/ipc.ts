import type { IpcRegistrar } from '@platform/ipc/main/ipc'
import type { MarkdownEditRequest, ResolvedMarkdownEdits } from '../contract/markdownEdits'
import type { ReaderNotes } from '../contract/readerNotes'
import type { CacheDocumentFigureRequest, CacheDocumentFigureResult, ListReaderAnnotationsRequest, MutateReaderAnnotationsRequest, ReaderAnnotationSnapshot } from '@shared/ipcSchemas'
import type { FigureDisplayStore } from './figureDisplayStore'
import { readerChannels } from '../contract/ipc'

export interface ReaderIpcDeps {
  figureDisplay: FigureDisplayStore
  /** Utility-owned notes store; throws while the database is not ready. */
  notes(): {
    list(request: { documentId: string }): Promise<ReaderNotes>
    upsert(request: { documentId: string; note: ReaderNotes['notes'][number] }): Promise<ReaderNotes>
    delete(request: { documentId: string; noteId: string }): Promise<ReaderNotes>
  }
  /** Annotation repository; throws while the database is not ready. */
  annotations(): {
    listDocumentAnnotations(request: ListReaderAnnotationsRequest): Promise<ReaderAnnotationSnapshot>
    mutateDocumentAnnotations(request: MutateReaderAnnotationsRequest): Promise<ReaderAnnotationSnapshot>
  }
  applyEdit(request: MarkdownEditRequest): Promise<{ revision: number }>
  resolvedEdits(documentId: string): Promise<ResolvedMarkdownEdits>
  cacheFigure(request: CacheDocumentFigureRequest): Promise<CacheDocumentFigureResult>
}

export function registerReaderIpc(ipc: IpcRegistrar, deps: ReaderIpcDeps): void {
  ipc.handle(readerChannels.figureDisplayGet, (_event, request) => deps.figureDisplay.get(request.documentId))
  ipc.handle(readerChannels.figureDisplaySet, (_event, request) => deps.figureDisplay.set(request))
  ipc.handle(readerChannels.notesList, (_event, request) => deps.notes().list(request))
  ipc.handle(readerChannels.notesUpsert, (_event, request) => deps.notes().upsert(request))
  ipc.handle(readerChannels.notesDelete, (_event, request) => deps.notes().delete(request))
  ipc.handle(readerChannels.annotationsList, async (_event, request) => deps.annotations().listDocumentAnnotations(request))
  ipc.handle(readerChannels.annotationsMutate, async (_event, request) => deps.annotations().mutateDocumentAnnotations(request))
  ipc.handle(readerChannels.editMarkdown, async (_event, request) => {
    const { revision } = await deps.applyEdit(request)
    // The resolved layer replaces the reader's optimistic view; the paper itself is not resent.
    return { revision, edits: await deps.resolvedEdits(request.documentId) }
  })
  ipc.handle(readerChannels.cacheFigure, (_event, request) => deps.cacheFigure(request))
}
