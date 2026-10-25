import React from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { DocumentAnnotation, ReaderAnnotationSnapshot } from '@shared/ipcSchemas'
import type { HighlightColor, ReaderAnnotation, ReaderAnnotationKind } from '@shared/types'
import type { ReaderNote, ReaderNotes } from '@shared/readerNotes'
import { IpcClientError } from '@platform/ipc/contract/envelope'
import { applyReaderAnnotationOperation, resolveReaderAnnotation } from '@shared/readerAnnotations'
import { buildAnnotationDiff, replayAnnotationDiff } from '@renderer/annotationMutations'
import { buildReaderHighlightRanges, captureReaderTextSelection, clearBrowserTextSelection, collectAnnotationBlockTexts, registerReaderHighlightRanges, type ReaderTextSelection } from '@renderer/readerAnnotations'
import ReaderAnnotationToolbar from '@renderer/components/ReaderAnnotationToolbar'
import { useReaderNoteLayer } from '@renderer/components/ReaderNotes'

const PREFIX = 'archive:'

/** Reuse the reader's durable, revision-checked marks; archive keys never match paper blocks. */
export default function ArchiveReadingTools(props: {
  documentId: string
  tab: string
  active: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const annotationKey = React.useMemo(() => ['annotations', props.documentId, 'original'], [props.documentId])
  const notesKey = React.useMemo(() => ['reader-notes', props.documentId], [props.documentId])
  const annotations = useQuery<ReaderAnnotationSnapshot>({
    queryKey: annotationKey, queryFn: () => window.copilotix.listReaderAnnotations({ documentId: props.documentId, view: 'original' }), enabled: props.active, retry: false
  })
  const notes = useQuery<ReaderNotes>({
    queryKey: notesKey, queryFn: () => window.copilotix.readerNotes.list({ documentId: props.documentId }), enabled: props.active, retry: false
  })
  const containerRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [owner] = React.useState(() => `archive-marks-${crypto.randomUUID()}`)
  const [selection, setSelection] = React.useState<ReaderTextSelection | null>(null)
  const [color, setColor] = React.useState<HighlightColor>('yellow')
  const [palette, setPalette] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const savingRef = React.useRef(false)
  const [error, setError] = React.useState('')
  const ready = props.active && annotations.isSuccess && notes.isSuccess
  const closeSelection = React.useCallback(() => {
    setSelection(null)
    setPalette(false)
    clearBrowserTextSelection()
  }, [])

  React.useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    // Also support saved legacy content and expanded source passages without nesting blocks.
    content.querySelectorAll<HTMLElement>('p,h3,h4').forEach((block, index) => {
      block.dataset.annotationBlockKey ??= `${PREFIX}${props.tab}:legacy:${index}`
    })
    const marks = (annotations.data?.annotations ?? []).filter(mark => mark.blockKey.startsWith(PREFIX))
      .map(mark => ({ ...mark, taskId: props.documentId }))
    return registerReaderHighlightRanges(owner, buildReaderHighlightRanges(content, marks))
  }, [annotations.data, owner, props.children, props.documentId, props.tab])

  React.useEffect(() => {
    if (!ready) { closeSelection(); return }
    let frame: number | null = null
    const capture = () => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = null
        setSelection(contentRef.current ? captureReaderTextSelection(contentRef.current) : null)
      })
    }
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && window.getSelection()?.toString() && contentRef.current?.contains(window.getSelection()?.anchorNode ?? null)) {
        event.preventDefault()
        closeSelection()
      }
    }
    document.addEventListener('selectionchange', capture)
    document.addEventListener('keydown', keyDown)
    const container = containerRef.current
    container?.addEventListener('scroll', closeSelection, { passive: true })
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', capture)
      document.removeEventListener('keydown', keyDown)
      container?.removeEventListener('scroll', closeSelection)
      clearBrowserTextSelection()
    }
  }, [ready, closeSelection])

  const saveNote = React.useCallback(async (note: ReaderNote) => {
    queryClient.setQueryData(notesKey, await window.copilotix.readerNotes.upsert({ documentId: props.documentId, note }))
  }, [notesKey, props.documentId, queryClient])
  const deleteNote = React.useCallback(async (noteId: string) => {
    queryClient.setQueryData(notesKey, await window.copilotix.readerNotes.delete({ documentId: props.documentId, noteId }))
  }, [notesKey, props.documentId, queryClient])
  const archiveNotes = React.useMemo(() => (notes.data?.notes ?? []).filter(note => note.anchors.every(anchor => anchor.blockKey.startsWith(PREFIX))), [notes.data])
  const noteLayer = useReaderNoteLayer({
    active: props.active, ready, view: 'original', notes: archiveNotes, containerRef, articleRef: contentRef,
    contentKey: props.children, onSave: ready ? saveNote : undefined, onDelete: ready ? deleteNote : undefined
  })

  const apply = async (kind: ReaderAnnotationKind): Promise<void> => {
    const base = annotations.data
    const content = contentRef.current
    if (!base || !selection || !content || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError('')
    const texts = collectAnnotationBlockTexts(content)
    const existing: ReaderAnnotation[] = base.annotations.filter(mark => mark.blockKey.startsWith(PREFIX)).map(mark => {
      const text = texts.get(mark.blockKey)
      const resolved = text === undefined ? null : resolveReaderAnnotation(text, { ...mark, taskId: props.documentId })
      return { ...mark, taskId: props.documentId, ...(resolved && text !== undefined ? {
        startOffset: resolved.startOffset, endOffset: resolved.endOffset,
        prefix: text.slice(Math.max(0, resolved.startOffset - 32), resolved.startOffset), suffix: text.slice(resolved.endOffset, resolved.endOffset + 32)
      } : {}) }
    })
    const next = applyReaderAnnotationOperation({ existing, taskId: props.documentId, view: 'original', kind, color: kind === 'highlight' ? color : null, selections: selection.fragments, blockTexts: texts, createId: () => crypto.randomUUID() })
    const nextRows: DocumentAnnotation[] = next.map(({ taskId: _taskId, ...mark }) => ({ ...mark, documentId: props.documentId, artifactId: base.artifactId }))
    // Diff only archive rows: normal reader annotations are never replaced or deleted here.
    const diff = buildAnnotationDiff(base.annotations.filter(mark => mark.blockKey.startsWith(PREFIX)), nextRows)
    const mutate = (snapshot: ReaderAnnotationSnapshot, changes: typeof diff) => window.copilotix.mutateReaderAnnotations({
      documentId: props.documentId, artifactId: snapshot.artifactId, view: 'original', expectedRevision: snapshot.revision, ...changes
    })
    closeSelection()
    try {
      let saved: ReaderAnnotationSnapshot
      try { saved = await mutate(base, diff) } catch (failure) {
        if (!(failure instanceof IpcClientError) || failure.code !== 'ANNOTATION_CONFLICT') throw failure
        const latest = await window.copilotix.listReaderAnnotations({ documentId: props.documentId, view: 'original' })
        if (latest.artifactId !== base.artifactId) throw new Error('论文原文已更新，请重新选择文本')
        const replay = replayAnnotationDiff(base.annotations, latest.annotations, diff)
        saved = replay.upserts.length || replay.deleteIds.length ? await mutate(latest, replay) : latest
      }
      queryClient.setQueryData(annotationKey, saved)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '标注保存失败，请重新选择文本后重试')
      void queryClient.invalidateQueries({ queryKey: annotationKey })
    } finally { savingRef.current = false; setSaving(false) }
  }

  return <div ref={containerRef} id="paper-archive-tabpanel" role="tabpanel" tabIndex={0} aria-labelledby={`paper-archive-tab-${props.tab}`}
    className="paper-archive-tabpanel paper-archive-reveal" style={{ '--i': 8 } as React.CSSProperties} aria-busy={saving}>
    <div ref={contentRef} className="paper-archive-reading-body">{props.children}</div>
    {error || annotations.isError || notes.isError ? <p className="paper-archive-reading-error" role="alert" data-reader-annotation-ignore="true">
      {error || '标注或笔记读取失败，暂时无法编辑。'}
      {annotations.isError || notes.isError ? <button type="button" onClick={() => { void annotations.refetch(); void notes.refetch() }}>重新读取</button> : null}
    </p> : null}
    {ready && selection && !saving ? createPortal(<ReaderAnnotationToolbar selection={selection} color={color} paletteOpen={palette}
      onPaletteOpen={() => setPalette(true)} onPaletteClose={() => setPalette(false)} onPaletteHover={() => {}} onPaletteHoverEnd={() => {}}
      onColorChange={setColor} onHighlight={() => void apply('highlight')} onUnderline={() => void apply('underline')}
      onNote={() => { noteLayer.startNote(selection); closeSelection() }} />, document.body) : null}
    {noteLayer.layer}
  </div>
}
