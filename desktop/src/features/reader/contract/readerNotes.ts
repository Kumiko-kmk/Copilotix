import { z } from 'zod'

/**
 * Sticky notes written against a passage of the original or translated Markdown. They live in
 * `<document>/notes/notes.v1.json` beside the paper (no database migration), are anchored like
 * reader annotations (block key, offsets, quote and context) and re-resolved when text moves.
 */
export const READER_NOTE_MAX_CHARS = 4_000
export const READER_NOTES_MAX = 2_000
export const READER_NOTES_MAX_BYTES = 4 * 1024 * 1024

const plain = (max: number) => z.string().max(max).refine((s) => !Array.from(s).some((c) => { const n = c.codePointAt(0)!; return (n < 32 && n !== 9 && n !== 10 && n !== 13) || (n >= 127 && n <= 159) }), 'Contains control characters')

export const readerNoteAnchorSchema = z.object({
  blockKey: z.string().min(1).max(256),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(1),
  quote: plain(16_384).pipe(z.string().min(1)),
  prefix: plain(64),
  suffix: plain(64)
}).strict().refine((anchor) => anchor.endOffset > anchor.startOffset, 'Empty anchor')

export const readerNoteSchema = z.object({
  id: z.string().uuid(),
  view: z.enum(['original', 'translated']),
  anchors: z.array(readerNoteAnchorSchema).min(1).max(64),
  body: plain(READER_NOTE_MAX_CHARS).pipe(z.string().trim().min(1)),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict()

export const readerNotesRequestSchema = z.object({ documentId: z.string().uuid() }).strict()
export const readerNotesSchema = z.object({ notes: z.array(readerNoteSchema).max(READER_NOTES_MAX) }).strict()
export const readerNoteUpsertSchema = readerNotesRequestSchema.extend({ note: readerNoteSchema }).strict()
export const readerNoteDeleteSchema = readerNotesRequestSchema.extend({ noteId: z.string().uuid() }).strict()

export type ReaderNoteAnchor = z.infer<typeof readerNoteAnchorSchema>
export type ReaderNote = z.infer<typeof readerNoteSchema>
export type ReaderNotes = z.infer<typeof readerNotesSchema>
