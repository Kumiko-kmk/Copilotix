import React from 'react'
import { createPortal } from 'react-dom'
import { Input } from 'antd'
import { READER_NOTE_MAX_CHARS, type ReaderNote, type ReaderNoteAnchor } from '../../contract/readerNotes'
import type { ReaderAnnotationView } from '@shared/types'
import {
  buildReaderNoteRanges,
  readerNoteAnchors,
  registerReaderHighlightRanges,
  type ReaderTextSelection
} from '../readerAnnotations'

/** A quill: the reader's sticky-note mark. */
export function QuillIcon(): React.JSX.Element {
  return (
    <svg className="reader-quill-icon" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M20 3c-6.6.3-11.6 4.7-12.7 11.6l-.4 2.6 2.7-.5C16.3 15.4 20.6 10.3 20 3Z" />
      <path d="M16.2 6.8 3.5 20.5" />
      <path d="M13.6 12.7H9.5" />
    </svg>
  )
}

interface ContentRect { left: number; top: number; right: number; bottom: number }
interface NoteGeometry { noteId: string; rects: ContentRect[]; marker: { left: number; top: number } }
interface NoteCard {
  /** null while the note is being written for the first time. */
  noteId: string | null
  anchors: ReaderNoteAnchor[]
  draft: string
  original: string
  origin: 'hover' | 'edit'
  left: number
  top: number
  above: boolean
}

const CARD_WIDTH = 320
const HOVER_OPEN_MS = 220
const HOVER_CLOSE_MS = 320
const MARKER_SIZE = 18

/**
 * Sticky notes over one Markdown view: the noted text is marked with a dotted underline and a
 * quill in the right margin; hovering either shows the note, editable in place. New notes start
 * from the selection toolbar (`startNote`).
 */
export function useReaderNoteLayer(options: {
  active: boolean
  ready: boolean
  view: ReaderAnnotationView
  notes: readonly ReaderNote[]
  containerRef: React.RefObject<HTMLDivElement | null>
  articleRef: React.RefObject<HTMLElement | null>
  /** Changes whenever the rendered text may have been rebuilt. */
  contentKey: unknown
  onSave?(note: ReaderNote): Promise<void>
  onDelete?(noteId: string): Promise<void>
}): { startNote(selection: ReaderTextSelection): void; layer: React.ReactNode; enabled: boolean } {
  const { active, ready, notes, containerRef, articleRef, contentKey } = options
  const enabled = Boolean(options.onSave)
  const optionsRef = React.useRef(options)
  optionsRef.current = options
  const [owner] = React.useState(() => `reader-notes-${crypto.randomUUID()}`)
  const rangesRef = React.useRef<Map<string, Range[]>>(new Map())
  const [geometry, setGeometry] = React.useState<NoteGeometry[]>([])
  const geometryRef = React.useRef(geometry)
  geometryRef.current = geometry
  const [card, setCard] = React.useState<NoteCard | null>(null)
  const cardRef = React.useRef(card)
  cardRef.current = card
  const [focused, setFocused] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const [confirmingDelete, setConfirmingDelete] = React.useState(false)
  const cardElementRef = React.useRef<HTMLDivElement>(null)
  const openTimerRef = React.useRef<number | null>(null)
  const closeTimerRef = React.useRef<number | null>(null)
  const pendingHoverRef = React.useRef<string | null>(null)
  const frameRef = React.useRef<number | null>(null)
  const dirty = Boolean(card && card.draft !== card.original)
  const sticky = Boolean(card && (card.origin === 'edit' || dirty || focused || saving))
  const stickyRef = React.useRef(sticky)
  stickyRef.current = sticky

  const measure = React.useCallback(() => {
    const container = containerRef.current
    const article = articleRef.current
    if (!container || !article) return
    const base = container.getBoundingClientRect()
    const toContent = (rect: DOMRect): ContentRect => ({
      left: rect.left - base.left + container.scrollLeft,
      top: rect.top - base.top + container.scrollTop,
      right: rect.right - base.left + container.scrollLeft,
      bottom: rect.bottom - base.top + container.scrollTop
    })
    const gutter = article.getBoundingClientRect().right - base.left + container.scrollLeft - 32
    const next: NoteGeometry[] = []
    for (const [noteId, ranges] of rangesRef.current) {
      const rects = ranges.flatMap((range) => Array.from(range.getClientRects()))
        .filter((rect) => rect.width > 0 && rect.height > 0).map(toContent)
      const first = rects[0]
      if (!first) continue
      next.push({ noteId, rects, marker: { left: gutter, top: first.top + (first.bottom - first.top - MARKER_SIZE) / 2 } })
    }
    // Notes that start on the same line stack downwards instead of covering each other.
    next.sort((a, b) => a.marker.top - b.marker.top)
    for (let i = 1; i < next.length; i++) {
      const previous = next[i - 1]!.marker.top
      if (next[i]!.marker.top < previous + MARKER_SIZE + 2) next[i]!.marker.top = previous + MARKER_SIZE + 2
    }
    setGeometry(next)
  }, [articleRef, containerRef])

  const scheduleMeasure = React.useCallback(() => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      measure()
    })
  }, [measure])

  React.useEffect(() => {
    const article = articleRef.current
    if (!ready || !article) {
      rangesRef.current = new Map()
      setGeometry([])
      return
    }
    const ranges = buildReaderNoteRanges(article, notes)
    rangesRef.current = ranges
    scheduleMeasure()
    return registerReaderHighlightRanges(owner, new Map([['copilotix-note', [...ranges.values()].flat()]]))
  }, [articleRef, contentKey, notes, owner, ready, scheduleMeasure])

  React.useEffect(() => {
    const article = articleRef.current
    if (!ready || !article || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(scheduleMeasure)
    observer.observe(article)
    return () => observer.disconnect()
  }, [articleRef, contentKey, ready, scheduleMeasure])

  const clearTimers = React.useCallback(() => {
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current)
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    openTimerRef.current = null
    closeTimerRef.current = null
    pendingHoverRef.current = null
  }, [])

  React.useEffect(() => () => {
    clearTimers()
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
  }, [clearTimers])

  const close = React.useCallback(() => {
    clearTimers()
    setCard(null)
    setFocused(false)
    setError('')
    setConfirmingDelete(false)
  }, [clearTimers])

  const place = React.useCallback((rect: { left: number; top: number; bottom: number }) => {
    const above = rect.bottom + 230 > window.innerHeight && rect.top > 240
    return {
      left: Math.max(12, Math.min(window.innerWidth - CARD_WIDTH - 12, rect.left)),
      top: above ? rect.top - 8 : rect.bottom + 8,
      above
    }
  }, [])

  const openNote = React.useCallback((noteId: string, origin: NoteCard['origin']) => {
    const note = notes.find((item) => item.id === noteId)
    const ranges = rangesRef.current.get(noteId)
    if (!note || !ranges?.length) return
    const rects = ranges.map((range) => range.getBoundingClientRect())
    const top = Math.min(...rects.map((rect) => rect.top))
    const bottom = Math.max(...rects.map((rect) => rect.bottom))
    setError('')
    setConfirmingDelete(false)
    setCard({ noteId, anchors: note.anchors, draft: note.body, original: note.body, origin, ...place({ left: rects[0]!.left, top, bottom }) })
  }, [notes, place])

  const hover = React.useCallback((noteId: string | null) => {
    if (!active || stickyRef.current) return
    const current = cardRef.current
    if (noteId && current?.noteId === noteId) {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
      return
    }
    if (noteId) {
      if (pendingHoverRef.current === noteId) return
      if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current)
      pendingHoverRef.current = noteId
      openTimerRef.current = window.setTimeout(() => {
        openTimerRef.current = null
        pendingHoverRef.current = null
        openNote(noteId, 'hover')
      }, HOVER_OPEN_MS)
      return
    }
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current)
    openTimerRef.current = null
    pendingHoverRef.current = null
    if (current && closeTimerRef.current === null) {
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null
        if (!stickyRef.current) close()
      }, HOVER_CLOSE_MS)
    }
  }, [active, close, openNote])

  // Hovering the noted text itself: hit-test the measured line boxes.
  React.useEffect(() => {
    const container = containerRef.current
    if (!active || !ready || !container || !enabled) return
    let frame: number | null = null
    let last: MouseEvent | null = null
    const test = (): void => {
      frame = null
      if (!last) return
      const base = container.getBoundingClientRect()
      const x = last.clientX - base.left + container.scrollLeft
      const y = last.clientY - base.top + container.scrollTop
      if ((last.target as Element | null)?.closest?.('.reader-note-marker')) return
      const hit = geometryRef.current.find((item) => item.rects.some((rect) => x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1))
      hover(hit?.noteId ?? null)
    }
    const onMove = (event: MouseEvent): void => {
      last = event
      if (frame === null) frame = window.requestAnimationFrame(test)
    }
    const onLeave = (): void => { last = null; hover(null) }
    container.addEventListener('mousemove', onMove)
    container.addEventListener('mouseleave', onLeave)
    return () => {
      container.removeEventListener('mousemove', onMove)
      container.removeEventListener('mouseleave', onLeave)
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [active, containerRef, enabled, hover, ready])

  const save = React.useCallback(async (): Promise<boolean> => {
    const current = cardRef.current
    const { onSave, view, notes: latest } = optionsRef.current
    if (!current || !onSave) return false
    const body = current.draft.trim()
    if (!body) {
      if (current.noteId === null) { close(); return true }
      setError('笔记内容不能为空；不再需要时请删除')
      return false
    }
    if (current.noteId !== null && current.draft === current.original) { close(); return true }
    const now = new Date().toISOString()
    const existing = current.noteId ? latest.find((note) => note.id === current.noteId) : undefined
    const note: ReaderNote = existing
      ? { ...existing, body, updatedAt: now }
      : { id: crypto.randomUUID(), view, anchors: current.anchors, body, createdAt: now, updatedAt: now }
    setSaving(true)
    setError('')
    try {
      await onSave(note)
      close()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '笔记保存失败，请重试')
      return false
    } finally {
      setSaving(false)
    }
  }, [close])

  const remove = React.useCallback(async () => {
    const current = cardRef.current
    const { onDelete } = optionsRef.current
    if (!current?.noteId || !onDelete) return
    setSaving(true)
    setError('')
    try {
      await onDelete(current.noteId)
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '笔记删除失败，请重试')
    } finally {
      setSaving(false)
    }
  }, [close])

  // Clicking elsewhere keeps what was written: the note saves, an untouched one just closes.
  React.useEffect(() => {
    if (!card) return
    const onPointerDown = (event: PointerEvent): void => {
      if (cardElementRef.current?.contains(event.target as Node)) return
      if ((event.target as Element | null)?.closest?.('.reader-note-marker')) return
      if (dirty || card.noteId === null) void save()
      else close()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [card, close, dirty, save])

  // The card follows its text while the view scrolls; a passing hover card simply closes.
  React.useEffect(() => {
    const container = containerRef.current
    if (!card || !container) return
    const onScroll = (): void => {
      const current = cardRef.current
      if (!current) return
      if (!stickyRef.current) { close(); return }
      const rects = current.noteId ? rangesRef.current.get(current.noteId)?.map((range) => range.getBoundingClientRect()) : undefined
      if (!rects?.length) return
      const top = Math.min(...rects.map((rect) => rect.top))
      const bottom = Math.max(...rects.map((rect) => rect.bottom))
      setCard({ ...current, ...place({ left: rects[0]!.left, top, bottom }) })
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [card, close, containerRef, place])

  React.useEffect(() => {
    if (!active) close()
  }, [active, close])

  // A note deleted elsewhere closes its card.
  React.useEffect(() => {
    if (card?.noteId && !notes.some((note) => note.id === card.noteId)) close()
  }, [card, close, notes])

  const startNote = React.useCallback((selection: ReaderTextSelection) => {
    const article = articleRef.current
    if (!article || !optionsRef.current.onSave) return
    clearTimers()
    setConfirmingDelete(false)
    const anchors = readerNoteAnchors(article, selection)
    if (anchors.length > 64 || anchors.some((anchor) => anchor.quote.length > 16_384)) {
      setError('选区过长，请缩小范围后再写笔记')
    } else {
      setError('')
    }
    setCard({ noteId: null, anchors, draft: '', original: '', origin: 'edit', ...place(selection.rect) })
  }, [articleRef, clearTimers, place])

  const tooLong = Boolean(card && (card.anchors.length > 64 || card.anchors.some((anchor) => anchor.quote.length > 16_384)))
  const note = card?.noteId ? notes.find((item) => item.id === card.noteId) : undefined
  const layer = enabled ? <>
    {active && ready && geometry.length ? (
      <div className="reader-note-markers" data-reader-annotation-ignore="true">
        {geometry.map((item) => (
          <button
            key={item.noteId}
            type="button"
            className={`reader-note-marker${card?.noteId === item.noteId ? ' active' : ''}`}
            style={{ left: item.marker.left, top: item.marker.top }}
            aria-label="查看笔记"
            onMouseEnter={() => hover(item.noteId)}
            onMouseLeave={() => hover(null)}
            onClick={() => openNote(item.noteId, 'edit')}
          >
            <QuillIcon />
          </button>
        ))}
      </div>
    ) : null}
    {card ? createPortal(
      <div
        ref={cardElementRef}
        className={`reader-note-card${card.above ? ' above' : ''}`}
        style={{ left: card.left, top: card.top, width: CARD_WIDTH }}
        role="dialog"
        aria-label={card.noteId ? '笔记' : '新建笔记'}
        onMouseEnter={() => { if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null }}
        onMouseLeave={() => hover(null)}
        onFocus={() => setFocused(true)}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false) }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); close() }
          else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save() }
        }}
      >
        <div className="reader-note-card-head">
          <QuillIcon />
          <span>{card.noteId ? '笔记' : '新建笔记'}</span>
          {note ? <time dateTime={note.updatedAt}>{new Date(note.updatedAt).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time> : null}
        </div>
        <blockquote className="reader-note-card-quote">{card.anchors.map((anchor) => anchor.quote).join(' … ').slice(0, 120)}</blockquote>
        <Input.TextArea
          aria-label="笔记内容"
          className="reader-note-card-input"
          variant="borderless"
          value={card.draft}
          maxLength={READER_NOTE_MAX_CHARS}
          autoSize={{ minRows: 3, maxRows: 10 }}
          autoFocus={card.origin === 'edit'}
          placeholder="写下对这段内容的想法…"
          disabled={tooLong}
          onChange={(event) => setCard({ ...card, draft: event.target.value })}
        />
        {error ? <div className="reader-note-card-error" role="alert">{error}</div> : null}
        <div className="reader-note-card-actions">
          {card.noteId ? (
            confirmingDelete
              ? <button type="button" className="danger" disabled={saving} onClick={() => void remove()}>确认删除</button>
              : <button type="button" disabled={saving} onClick={() => setConfirmingDelete(true)}>删除</button>
          ) : null}
          <span className="reader-note-card-hint">Ctrl+Enter 保存</span>
          <button type="button" className="primary" disabled={saving || tooLong || (card.noteId !== null && !dirty)} onClick={() => void save()}>保存</button>
        </div>
      </div>,
      document.body
    ) : null}
  </> : null
  return { startNote, layer, enabled }
}
