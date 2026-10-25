import { markdownEditRequestSchema, markdownEditResultSchema } from './markdownEdits'
import { readerNoteDeleteSchema, readerNoteUpsertSchema, readerNotesRequestSchema, readerNotesSchema } from './readerNotes'
import { z } from 'zod'
import { documentAnnotationViewSchema, mutateReaderAnnotationsRequestSchema, readerAnnotationSnapshotSchema } from './ipcSchemas'

import { coreIdSchema } from '@platform/rpc/contract/protocol'

export const coreAnnotationsSnapshotPayloadSchema = z.object({ documentId: coreIdSchema, view: documentAnnotationViewSchema }).strict()
export const coreAnnotationsSnapshotResultSchema = readerAnnotationSnapshotSchema
export const coreAnnotationsMutatePayloadSchema = z.object({ request: mutateReaderAnnotationsRequestSchema }).strict()
export const coreAnnotationsMutateResultSchema = readerAnnotationSnapshotSchema
/**
 * Feature operations still declared here until each module owns its contract (milestone M4).
 * The app registry (`app/contract/coreRpc.ts`) combines them with platform and job operations.
 */
export const featureOperations = {
  'notes:list': { payload: readerNotesRequestSchema, result: readerNotesSchema },
  'notes:upsert': { payload: readerNoteUpsertSchema, result: readerNotesSchema },
  'notes:delete': { payload: readerNoteDeleteSchema, result: readerNotesSchema },
  'markdown-edits:apply': { payload: markdownEditRequestSchema, result: markdownEditResultSchema },
  'annotations:list-snapshot': { payload: coreAnnotationsSnapshotPayloadSchema, result: coreAnnotationsSnapshotResultSchema },
  'annotations:mutate': { payload: coreAnnotationsMutatePayloadSchema, result: coreAnnotationsMutateResultSchema }
} as const
