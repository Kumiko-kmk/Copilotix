import React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReaderNote, ReaderNotes } from '@shared/readerNotes'

const NO_NOTES: ReaderNote[] = []

/** The paper's sticky notes; every save or delete returns, and caches, the stored list. */
export function useReaderNotes(documentId: string): {
  notes: ReaderNote[]
  saveNote(note: ReaderNote): Promise<void>
  deleteNote(noteId: string): Promise<void>
} {
  const queryClient = useQueryClient()
  const queryKey = React.useMemo(() => ['reader-notes', documentId], [documentId])
  const query = useQuery<ReaderNotes>({ queryKey, queryFn: () => window.copilotix.readerNotes.list({ documentId }) })
  const saveNote = React.useCallback(async (note: ReaderNote) => {
    queryClient.setQueryData(queryKey, await window.copilotix.readerNotes.upsert({ documentId, note }))
  }, [documentId, queryClient, queryKey])
  const deleteNote = React.useCallback(async (noteId: string) => {
    queryClient.setQueryData(queryKey, await window.copilotix.readerNotes.delete({ documentId, noteId }))
  }, [documentId, queryClient, queryKey])
  return { notes: query.data?.notes ?? NO_NOTES, saveNote, deleteNote }
}
