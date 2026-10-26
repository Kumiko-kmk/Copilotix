import type { CoreUtilityOperationHandler } from '@platform/rpc/utility/coreUtilityRuntime'
import type { V2TaskRepositoryCompat } from '@features/library/utility'
import { markdownEditRequestSchema } from '../contract/markdownEdits'
import { readerNoteDeleteSchema, readerNoteUpsertSchema, readerNotesRequestSchema } from '../contract/readerNotes'
import type { ReaderOperations } from '../contract/rpc'
import { MarkdownEditStore } from './markdownEditStore'
import { ReaderNoteStore } from './readerNoteStore'

/** Utility handlers of the reader's user layers; `repository` throws while the database is not ready. */
export function createReaderOperations(repository: () => V2TaskRepositoryCompat) {
  const noteStore = new ReaderNoteStore((id) => repository().getTask(id)?.outputDir ?? null)
  const editStore = new MarkdownEditStore((id) => repository().getTask(id)?.outputDir ?? null)
  const handlers: Record<keyof ReaderOperations, CoreUtilityOperationHandler> = {
    'markdown-edits:apply': (request) => editStore.apply(markdownEditRequestSchema.parse(request.payload)),
    'notes:list': (request) => noteStore.list(readerNotesRequestSchema.parse(request.payload).documentId),
    'notes:upsert': (request) => { const { documentId, note } = readerNoteUpsertSchema.parse(request.payload); return noteStore.upsert(documentId, note) },
    'notes:delete': (request) => { const { documentId, noteId } = readerNoteDeleteSchema.parse(request.payload); return noteStore.delete(documentId, noteId) },
    'annotations:list-snapshot': (request) => {
      const payload = request.payload as Parameters<V2TaskRepositoryCompat['listDocumentAnnotations']>[0]
      return repository().listDocumentAnnotations(payload)
    },
    'annotations:mutate': (request) => repository().mutateDocumentAnnotations((request.payload as { request: Parameters<V2TaskRepositoryCompat['mutateDocumentAnnotations']>[0] }).request)
  }
  /** The edit layer is also read by chat (its context follows the user's edits). */
  return { handlers, editStore }
}
