import { z } from 'zod'
import { documentAnnotationViewSchema, mutateReaderAnnotationsRequestSchema, readerAnnotationSnapshotSchema } from './readerSchemas'
import { coreIdSchema } from '@platform/rpc/contract/protocol'
import { markdownEditRequestSchema, markdownEditResultSchema } from './markdownEdits'
import { readerNoteDeleteSchema, readerNoteUpsertSchema, readerNotesRequestSchema, readerNotesSchema } from './readerNotes'

export const coreAnnotationsSnapshotPayloadSchema = z.object({ documentId: coreIdSchema, view: documentAnnotationViewSchema }).strict()
export const coreAnnotationsSnapshotResultSchema = readerAnnotationSnapshotSchema
export const coreAnnotationsMutatePayloadSchema = z.object({ request: mutateReaderAnnotationsRequestSchema }).strict()
export const coreAnnotationsMutateResultSchema = readerAnnotationSnapshotSchema

/** Core RPC operations of the reader's per-document user layers: notes, the Markdown edit layer and annotations. */
export const readerOperations = {
  'notes:list': { payload: readerNotesRequestSchema, result: readerNotesSchema },
  'notes:upsert': { payload: readerNoteUpsertSchema, result: readerNotesSchema },
  'notes:delete': { payload: readerNoteDeleteSchema, result: readerNotesSchema },
  'markdown-edits:apply': { payload: markdownEditRequestSchema, result: markdownEditResultSchema },
  'annotations:list-snapshot': { payload: coreAnnotationsSnapshotPayloadSchema, result: coreAnnotationsSnapshotResultSchema },
  'annotations:mutate': { payload: coreAnnotationsMutatePayloadSchema, result: coreAnnotationsMutateResultSchema }
} as const
export type ReaderOperations = typeof readerOperations
