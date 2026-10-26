import React from 'react'
import { createPortal } from 'react-dom'
import type { ReaderBlock } from '../../core/readerDocument'
import type { BlockSelection, ReaderAnnotationView } from '../../contract/readerTypes'
import {
  buildCitationIndex,
  counterpartEntry,
  findCitations,
  looksLikeAuthorLine,
  superscriptCitation,
  type CitationIndex,
  type ReferenceEntry
} from '../readerCitations'
import { registerReaderHighlightRanges } from '../readerAnnotations'
import { SYNC_READING_LINE } from '../readerScrollSync'

interface CitationHit { range: Range; entries: ReferenceEntry[]; missing: number[] }
interface CitationCard { hit: CitationHit; left: number; top: number; above: boolean; maxHeight: number }

const CARD_WIDTH = 440
const HOVER_OPEN_MS = 160
const HOVER_CLOSE_MS = 260
const TARGET_FLASH_MS = 2400
/** Formulas, code and the reader's own controls never hold citations. */
const SKIPPED = '.katex, code, pre, a, [data-reader-annotation-ignore]'

/**
 * Citation markers of one Markdown view, resolved against the paper's own reference list
 * (readerCitations.ts): hovering a marker shows the cited entries — with the other view's text
 * when it differs — and clicking one scrolls to the entry in the list and flashes it.
 * Hovering is the user's requested exception to the no-hover rule (docs/UI_PREFERENCES_ZH.md).
 */
export function useReaderCitationLayer(options: {
  active: boolean
  ready: boolean
  view: ReaderAnnotationView
  blocks: readonly ReaderBlock[]
  /** The other reading view, whose entry text is shown alongside when it differs. */
  counterpartBlocks?: readonly ReaderBlock[]
  containerRef: React.RefObject<HTMLDivElement | null>
  articleRef: React.RefObject<HTMLElement | null>
  /** Changes whenever the rendered text may have been rebuilt. */
  contentKey: unknown
  onNavigate(selection: BlockSelection): void
}): React.ReactNode {
  const { active, ready, blocks, counterpartBlocks, containerRef, articleRef, contentKey } = options
  const index = React.useMemo(() => buildCitationIndex(blocks), [blocks])
  const counterpart = React.useMemo(() => counterpartBlocks?.length ? buildCitationIndex(counterpartBlocks) : null, [counterpartBlocks])
  const [owner] = React.useState(() => `reader-citations-${crypto.randomUUID()}`)
  const hitsRef = React.useRef(new Map<Text, CitationHit[]>())
  const [card, setCard] = React.useState<CitationCard | null>(null)
  const cardRef = React.useRef(card)
  cardRef.current = card
  const openTimerRef = React.useRef<number | null>(null)
  const closeTimerRef = React.useRef<number | null>(null)
  const pendingRef = React.useRef<CitationHit | null>(null)
  const flashRef = React.useRef<{ timer: number; release(): void } | null>(null)
  const navigateRef = React.useRef(options.onNavigate)
  navigateRef.current = options.onNavigate

  React.useEffect(() => {
    const article = articleRef.current
    if (!ready || !article || !index.style) {
      hitsRef.current = new Map()
      return
    }
    const scanned = scanCitations(article, index)
    hitsRef.current = scanned.byNode
    return registerReaderHighlightRanges(owner, new Map([['copilotix-citation', scanned.ranges]]))
  }, [articleRef, contentKey, index, owner, ready])

  const clearTimers = React.useCallback(() => {
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current)
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    openTimerRef.current = null
    closeTimerRef.current = null
    pendingRef.current = null
  }, [])

  const close = React.useCallback(() => {
    clearTimers()
    setCard(null)
  }, [clearTimers])

  const keepOpen = React.useCallback(() => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])

  const hover = React.useCallback((hit: CitationHit | null) => {
    if (hit && cardRef.current?.hit === hit) { keepOpen(); return }
    if (hit) {
      if (pendingRef.current === hit) return
      if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current)
      pendingRef.current = hit
      openTimerRef.current = window.setTimeout(() => {
        openTimerRef.current = null
        pendingRef.current = null
        keepOpen()
        setCard(placeCard(hit))
      }, HOVER_OPEN_MS)
      return
    }
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current)
    openTimerRef.current = null
    pendingRef.current = null
    if (cardRef.current && closeTimerRef.current === null) {
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null
        setCard(null)
      }, HOVER_CLOSE_MS)
    }
  }, [keepOpen])

  const navigate = React.useCallback((entry: ReferenceEntry) => {
    const article = articleRef.current
    const element = article?.querySelector<HTMLElement>(`[data-reader-block-index="${entry.blockIndex}"]`)
    if (!element) return
    close()
    const mappingId = element.dataset.blockIds?.split(/\s+/u).find(Boolean)
    if (mappingId) navigateRef.current({ mappingId, origin: 'markdown' })
    const range = entryRange(element, entry)
    // After the selection has scrolled its block into view, put the entry itself on the
    // reading line, so a block holding several entries still lands on the right one.
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const container = containerRef.current
      if (!container) return
      const rect = range.getBoundingClientRect()
      const base = container.getBoundingClientRect()
      container.scrollTop += rect.top - base.top - Math.max(0, container.clientHeight * SYNC_READING_LINE - rect.height / 2)
      if (flashRef.current) { window.clearTimeout(flashRef.current.timer); flashRef.current.release() }
      const release = registerReaderHighlightRanges(`${owner}-target`, new Map([['copilotix-citation-target', [range]]]))
      flashRef.current = { release, timer: window.setTimeout(() => { release(); flashRef.current = null }, TARGET_FLASH_MS) }
    }))
  }, [articleRef, close, containerRef, owner])

  React.useEffect(() => () => {
    clearTimers()
    if (flashRef.current) { window.clearTimeout(flashRef.current.timer); flashRef.current.release() }
  }, [clearTimers])

  // Hovering a marker: the caret position under the pointer names its text node.
  React.useEffect(() => {
    const container = containerRef.current
    const article = articleRef.current
    if (!active || !ready || !container || !article || !index.style) return
    let frame: number | null = null
    let last: MouseEvent | null = null
    let pointer = false
    const setPointer = (value: boolean): void => {
      if (value !== pointer) container.classList.toggle('reader-citation-pointer', (pointer = value))
    }
    const test = (): void => {
      frame = null
      if (!last) return
      // Dragging out a selection must not open cards along the way.
      const hit = last.buttons === 0 ? hitAt(article, hitsRef.current, last.clientX, last.clientY) : null
      setPointer(Boolean(hit))
      hover(hit)
    }
    const onMove = (event: MouseEvent): void => {
      last = event
      if (frame === null) frame = window.requestAnimationFrame(test)
    }
    const onLeave = (): void => { last = null; setPointer(false); hover(null) }
    const onClick = (event: MouseEvent): void => {
      if (event.button !== 0 || (window.getSelection() && !window.getSelection()!.isCollapsed)) return
      const hit = hitAt(article, hitsRef.current, event.clientX, event.clientY)
      if (!hit) return
      // Capture phase: the citing paragraph must not also take the selection.
      event.preventDefault()
      event.stopPropagation()
      navigate(hit.entries[0]!)
    }
    const onScroll = (): void => { if (cardRef.current || pendingRef.current) close() }
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape' && cardRef.current) close() }
    container.addEventListener('mousemove', onMove)
    container.addEventListener('mouseleave', onLeave)
    container.addEventListener('click', onClick, true)
    container.addEventListener('scroll', onScroll, { passive: true })
    document.addEventListener('keydown', onKeyDown)
    return () => {
      container.removeEventListener('mousemove', onMove)
      container.removeEventListener('mouseleave', onLeave)
      container.removeEventListener('click', onClick, true)
      container.removeEventListener('scroll', onScroll)
      document.removeEventListener('keydown', onKeyDown)
      if (frame !== null) window.cancelAnimationFrame(frame)
      setPointer(false)
    }
  }, [active, articleRef, close, containerRef, hover, index.style, navigate, ready])

  React.useEffect(() => {
    if (!active || !ready) close()
  }, [active, close, ready])

  if (!card) return null
  const otherLabel = options.view === 'original' ? '译文' : '原文'
  return createPortal(
    <div
      className={`reader-citation-card${card.above ? ' above' : ''}`}
      style={{ left: card.left, top: card.top, width: CARD_WIDTH, maxHeight: card.maxHeight }}
      role="dialog"
      aria-label="参考文献"
      data-reader-annotation-ignore="true"
      onMouseEnter={keepOpen}
      onMouseLeave={() => hover(null)}
    >
      {card.hit.entries.map((entry) => {
        const other = counterpartEntry(entry, index, counterpart)
        return (
          <button key={entry.id} type="button" className="reader-citation-entry" onClick={() => navigate(entry)}>
            {entry.number !== undefined ? <span className="reader-citation-number">[{entry.number}]</span> : null}
            <span className="reader-citation-text">{entry.text}</span>
            {other ? <span className="reader-citation-other"><em>{otherLabel}</em>{other.text}</span> : null}
          </button>
        )
      })}
      {card.hit.missing.length ? (
        <p className="reader-citation-missing">[{card.hit.missing.join(', ')}] 未能从本文参考文献列表中解析</p>
      ) : null}
    </div>,
    document.body
  )
}

function scanCitations(article: HTMLElement, index: CitationIndex): { byNode: Map<Text, CitationHit[]>; ranges: Range[] } {
  const byNode = new Map<Text, CitationHit[]>()
  const ranges: Range[] = []
  for (const block of article.querySelectorAll<HTMLElement>('[data-reader-block-index]')) {
    if (index.referenceBlocks.has(Number(block.dataset.readerBlockIndex))) continue
    let authorLine: boolean | undefined
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const parent = node.parentElement
      if (!parent || parent.closest(SKIPPED)) continue
      const hits: CitationHit[] = []
      const superscript = parent.closest('sup')
      if (superscript) {
        // Only a whole superscript is a marker; author lines carry affiliation numbers.
        if (!index.superscripts || superscript.textContent !== node.data) continue
        authorLine ??= looksLikeAuthorLine(textWithoutSuperscripts(block))
        const resolved = authorLine ? null : superscriptCitation(node.data, index)
        if (resolved) hits.push({ range: textRange(node, 0, node.data.length), ...resolved })
      } else {
        for (const match of findCitations(node.data, index)) {
          hits.push({ range: textRange(node, match.start, match.end), entries: match.entries, missing: match.missing })
        }
      }
      if (hits.length) {
        byNode.set(node, hits)
        ranges.push(...hits.map((hit) => hit.range))
      }
    }
  }
  return { byNode, ranges }
}

function textWithoutSuperscripts(block: HTMLElement): string {
  const copy = block.cloneNode(true) as HTMLElement
  for (const superscript of copy.querySelectorAll('sup')) superscript.remove()
  return copy.textContent ?? ''
}

function textRange(node: Text, start: number, end: number): Range {
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  return range
}

function hitAt(article: HTMLElement, hits: Map<Text, CitationHit[]>, x: number, y: number): CitationHit | null {
  if (hits.size === 0) return null
  const position = caretAt(x, y)
  if (!position || !article.contains(position.node)) return null
  // At a node boundary the caret may report the neighbouring text node.
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT)
  walker.currentNode = position.node
  const previous = walker.previousNode()
  walker.currentNode = position.node
  const next = walker.nextNode()
  for (const node of [position.node, previous, next]) {
    for (const hit of (node instanceof Text ? hits.get(node) : undefined) ?? []) {
      if (Array.from(hit.range.getClientRects()).some((rect) => x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1)) return hit
    }
  }
  return null
}

function caretAt(x: number, y: number): { node: Node } | null {
  const view = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node } | null }
  if (view.caretPositionFromPoint) {
    const position = view.caretPositionFromPoint(x, y)
    return position ? { node: position.offsetNode } : null
  }
  const range = document.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer } : null
}

function placeCard(hit: CitationHit): CitationCard {
  const rect = hit.range.getClientRects()[0] ?? hit.range.getBoundingClientRect()
  const below = window.innerHeight - rect.bottom - 16
  const above = rect.top - 16
  const placeAbove = below < 220 && above > below
  return {
    hit,
    left: Math.max(12, Math.min(window.innerWidth - CARD_WIDTH - 12, rect.left - 16)),
    top: placeAbove ? rect.top - 6 : rect.bottom + 6,
    above: placeAbove,
    maxHeight: Math.max(120, Math.min(420, (placeAbove ? above : below) - 6))
  }
}

/** The entry's own text inside its block, so a paragraph holding several entries flashes only one. */
function entryRange(element: HTMLElement, entry: ReferenceEntry): Range {
  const characters: Array<{ node: Text; offset: number }> = []
  let compact = ''
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (node.parentElement?.closest('.katex-mathml, [data-reader-annotation-ignore]')) continue
    for (let offset = 0; offset < node.data.length; offset += 1) {
      if (/\s/u.test(node.data[offset]!)) continue
      compact += node.data[offset]
      characters.push({ node, offset })
    }
  }
  const target = entry.text.replace(/\s+/gu, '')
  const head = target.slice(0, 24)
  const tail = target.slice(-16)
  const start = head ? compact.indexOf(head) : -1
  const tailAt = start < 0 ? -1 : compact.indexOf(tail, start)
  const range = document.createRange()
  if (start < 0 || tailAt < 0) {
    range.selectNodeContents(element)
    return range
  }
  const first = characters[start]!
  const last = characters[tailAt + tail.length - 1]!
  range.setStart(first.node, first.offset)
  range.setEnd(last.node, last.offset + 1)
  return range
}
