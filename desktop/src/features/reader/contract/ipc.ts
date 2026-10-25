import { invokeChannel, type IpcBridge } from '@platform/ipc/contract/channels'
import { figureDisplayChoicesSchema, figureDisplayRequestSchema, figureDisplaySetRequestSchema, type FigureDisplayDesktopApi } from '@shared/figureDisplay'
import { markdownEditRequestSchema, markdownEditResultSchema, type MarkdownEditRequest, type ResolvedMarkdownEdits } from '@shared/markdownEdits'
import { readerNoteDeleteSchema, readerNoteUpsertSchema, readerNotesRequestSchema, readerNotesSchema, type ReaderNote, type ReaderNotes } from '@shared/readerNotes'
import {
  listReaderAnnotationsRequestSchema,
  mutateReaderAnnotationsRequestSchema,
  readerAnnotationSnapshotSchema,
  type ListReaderAnnotationsRequest,
  type MutateReaderAnnotationsRequest,
  type ReaderAnnotationSnapshot
} from '@shared/ipcSchemas'

export const readerChannels = {
  figureDisplayGet: invokeChannel('reader-figure-display:get', figureDisplayRequestSchema, figureDisplayChoicesSchema),
  figureDisplaySet: invokeChannel('reader-figure-display:set', figureDisplaySetRequestSchema, figureDisplayChoicesSchema),
  notesList: invokeChannel('reader-notes:list', readerNotesRequestSchema, readerNotesSchema),
  notesUpsert: invokeChannel('reader-notes:upsert', readerNoteUpsertSchema, readerNotesSchema),
  notesDelete: invokeChannel('reader-notes:delete', readerNoteDeleteSchema, readerNotesSchema),
  annotationsList: invokeChannel('reader-annotations:list', listReaderAnnotationsRequestSchema, readerAnnotationSnapshotSchema),
  annotationsMutate: invokeChannel('reader-annotations:mutate', mutateReaderAnnotationsRequestSchema, readerAnnotationSnapshotSchema),
  /** The edit layer is written by Utility; Main only forwards the validated request. */
  editMarkdown: invokeChannel('documents:edit-markdown', markdownEditRequestSchema, markdownEditResultSchema)
}

export interface ReaderDesktopApi {
  /** Reader figures: PDF crop or parsed panels, remembered per figure (see shared/figureDisplay.ts). */
  figureDisplay: FigureDisplayDesktopApi
  readerNotes: {
    list(request: { documentId: string }): Promise<ReaderNotes>
    upsert(request: { documentId: string; note: ReaderNote }): Promise<ReaderNotes>
    delete(request: { documentId: string; noteId: string }): Promise<ReaderNotes>
  }
  /** Writes the reader's edit layer (edit, revert, delete or restore one block). */
  editDocumentMarkdown(request: MarkdownEditRequest): Promise<{ revision: number; edits?: ResolvedMarkdownEdits }>
  listReaderAnnotations(request: ListReaderAnnotationsRequest): Promise<ReaderAnnotationSnapshot>
  mutateReaderAnnotations(request: MutateReaderAnnotationsRequest): Promise<ReaderAnnotationSnapshot>
}

export function createReaderApi(ipc: IpcBridge): ReaderDesktopApi {
  return {
    figureDisplay: {
      get: request => ipc.invoke(readerChannels.figureDisplayGet, request),
      set: request => ipc.invoke(readerChannels.figureDisplaySet, request)
    },
    readerNotes: {
      list: request => ipc.invoke(readerChannels.notesList, request),
      upsert: request => ipc.invoke(readerChannels.notesUpsert, request),
      delete: request => ipc.invoke(readerChannels.notesDelete, request)
    },
    editDocumentMarkdown: request => ipc.invoke(readerChannels.editMarkdown, request),
    listReaderAnnotations: request => ipc.invoke(readerChannels.annotationsList, request),
    mutateReaderAnnotations: request => ipc.invoke(readerChannels.annotationsMutate, request)
  }
}
