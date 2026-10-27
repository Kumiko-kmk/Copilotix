import React from 'react'
import { createPortal } from 'react-dom'
import type { ReaderBlock } from '../../core/readerDocument'
import {
  applyReaderAnnotationOperation,
  resolveReaderAnnotation
} from '../../core/readerAnnotations'
import type {
  BlockSelection,
  HighlightColor,
  ReaderAnnotation,
  ReaderAnnotationKind,
  ReaderAnnotationView,
  ReaderChatSelection
} from '../../contract/readerTypes'
import {
  buildReaderHighlightRanges,
  captureReaderTextSelection,
  clearBrowserTextSelection,
  collectAnnotationBlockTexts,
  registerReaderHighlightRanges,
  type ReaderTextSelection
} from '../readerAnnotations'
import MarkdownMinimap from './MarkdownMinimap'
import { ReaderBlockEditor, blockTypography, type ReaderBlockEditing } from './ReaderBlockEditing'
import { useBlockReorder, type ReaderBlockMove } from './ReaderBlockReorder'
import { readerBlocksEqual, nearestBlockPosition, waitForImage, waitForAnimationFrames, readableRenderError, parseMappingIds, type BlockPosition } from './markdownPaneDom'
import { useMarkdownFigures, useReorderUnits } from './useMarkdownFigures'
import { MarkdownBlockMenuPopup, MarkdownRenderStatus, type MarkdownBlockMenu, type RenderState } from './MarkdownPaneParts'
export type { MarkdownBlockMenu } from './MarkdownPaneParts'
import { NO_READY_FIGURES, NO_NOTES, NO_MOSAICS, MarkdownBlockView } from './MarkdownBlockView'
export type { ReaderFigureChat } from './MarkdownBlockView'

/** Right-click menu on a paragraph, page header or figure; the reader decides the items. */
import { type ReaderFigureGroup } from '../../core/readerFigureGroups'
import { recordReaderDuration } from '../readerPerformance'
import { SYNC_READING_LINE, clampFraction, trackScrollIntent, type ScrollIntent, type ScrollSyncChannel } from '../readerScrollSync'
import { readerReferenceSections } from '../readerReferenceSections'
import { useReaderNoteLayer } from './ReaderNotes'
import { useReaderCitationLayer } from './ReaderCitations'
import ReaderAnnotationToolbar from './ReaderAnnotationToolbar'
import type { ReaderNote } from '../../contract/readerNotes'

const MARKDOWN_RENDER_TIMEOUT_MS = 30_000
/**
 * Long papers mount their blocks over several frames so opening one never
 * freezes the window. Short documents still mount in a single commit.
 */
export const MARKDOWN_INITIAL_BLOCKS = 80
export const MARKDOWN_BLOCKS_PER_FRAME = 40
const SCROLL_SELECTION_INTERVAL_MS = 80
const SCROLL_IDLE_DELAY_MS = 120

export default function MarkdownPane(props: {
  active: boolean
  blocks: ReaderBlock[]
  /** The other reading view's blocks: a cited entry also shows its text there when it differs. */
  counterpartBlocks?: ReaderBlock[]
  assetBaseUrl: string
  pdfUrl?: string
  figureGroups?: ReaderFigureGroup[]
  /** In-place editing and deletion of blocks; omitted where the text cannot be edited. */
  blockEditing?: ReaderBlockEditing
  blockMenu?: MarkdownBlockMenu
  /** Long-press drag and menu moves of whole paragraphs and figures. */
  blockMove?: ReaderBlockMove
  taskId: string
  view: ReaderAnnotationView
  annotations: ReaderAnnotation[]
  highlightColor: HighlightColor
  onHighlightColorChange(color: HighlightColor): void
  onReplaceAnnotations(annotations: ReaderAnnotation[]): Promise<void>
  onAddToChat?(selection: ReaderChatSelection): void
  /** Sticky notes of this view; without `onSaveNote` the note tool is hidden. */
  notes?: readonly ReaderNote[]
  onSaveNote?(note: ReaderNote): Promise<void>
  onDeleteNote?(noteId: string): Promise<void>
  selection: BlockSelection | null
  onSelect(selection: BlockSelection): void
  onRenderReady?(): void
  initialScrollTop?: number
  onScrollTopChange?(scrollTop: number): void
  /** Optional scroll sync with other reader views (follows and leads by block mapping). */
  scrollSync?: ScrollSyncChannel
}): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const paneRef = React.useRef<HTMLDivElement>(null)
  const scrollIntentRef = React.useRef<ScrollIntent | null>(null)
  const articleRef = React.useRef<HTMLElement>(null)
  const documentId = React.useId()
  const scrollFrameRef = React.useRef<number | null>(null)
  const resizeFrameRef = React.useRef<number | null>(null)
  const scrollSelectionTimerRef = React.useRef<number | null>(null)
  const scrollIdleTimerRef = React.useRef<number | null>(null)
  const navigationReleaseFrameRef = React.useRef<number | null>(null)
  const suppressScrollSelectionRef = React.useRef(false)
  const minimapDraggingRef = React.useRef(false)
  const scrollActiveRef = React.useRef(false)
  const resizePendingRef = React.useRef(false)
  const lastScrollMappingRef = React.useRef<string | null>(null)
  const blockPositionsRef = React.useRef<BlockPosition[]>([])
  const blockElementsRef = React.useRef<Map<string, HTMLElement>>(new Map())
  const ambiguousMappingIdsRef = React.useRef<Set<string>>(new Set())
  const navigationElementsRef = React.useRef<HTMLElement[]>([])
  const lastNavigatedSelectionRef = React.useRef<BlockSelection | null>(null)
  const initialScrollAppliedRef = React.useRef(false)
  const onRenderReadyRef = React.useRef(props.onRenderReady)
  onRenderReadyRef.current = props.onRenderReady
  const contentRevisionRef = React.useRef({ blocks: props.blocks, revision: 0 })
  if (!readerBlocksEqual(contentRevisionRef.current.blocks, props.blocks)) {
    contentRevisionRef.current = {
      blocks: props.blocks,
      revision: contentRevisionRef.current.revision + 1
    }
  }
  const contentRevision = contentRevisionRef.current.revision
  const referenceSections = React.useMemo(() => readerReferenceSections(props.blocks), [props.blocks])
  // The block whose edit actions are shown (set by clicking it) and the one being edited.
  const [blockEditor, setBlockEditor] = React.useState<{ key: string; typography: React.CSSProperties } | null>(null)
  const [blockMenuAt, setBlockMenuAt] = React.useState<{ block: ReaderBlock; figures: ReaderFigureGroup[]; x: number; y: number } | null>(null)
  const openBlockMenu = React.useCallback((block: ReaderBlock, figures: ReaderFigureGroup[], x: number, y: number) => setBlockMenuAt({ block, figures, x, y }), [])
  const closeBlockMenu = React.useCallback(() => setBlockMenuAt(null), [])
  const closeBlockEditor = React.useCallback(() => setBlockEditor(null), [])
  // A second single click on the current paragraph edits it. Waiting out the double-click interval
  // keeps word and paragraph selection (for highlights and notes) working on that paragraph.
  const pendingEditRef = React.useRef<number | null>(null)
  const requestBlockEdit = React.useCallback((key: string, element: HTMLElement, clicks: number) => {
    if (pendingEditRef.current !== null) window.clearTimeout(pendingEditRef.current)
    pendingEditRef.current = null
    if (clicks > 1) return
    pendingEditRef.current = window.setTimeout(() => {
      pendingEditRef.current = null
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed) return
      setBlockEditor({ key, typography: blockTypography(element) })
    }, 260)
  }, [])
  React.useEffect(() => () => { if (pendingEditRef.current !== null) window.clearTimeout(pendingEditRef.current) }, [])
  const [annotationOwner] = React.useState(() => `reader-annotations-${crypto.randomUUID()}`)
  const selectionFrameRef = React.useRef<number | null>(null)
  const paletteTimerRef = React.useRef<number | null>(null)
  const [textSelection, setTextSelection] = React.useState<ReaderTextSelection | null>(null)
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [renderAttempt, setRenderAttempt] = React.useState(0)
  const [layoutRevision, setLayoutRevision] = React.useState(0)
  const [yellowHighlightRanges, setYellowHighlightRanges] = React.useState<readonly Range[]>([])
  const [renderState, setRenderState] = React.useState<RenderState>({
    status: 'loading',
    completedImages: 0,
    totalImages: 0
  })
  const ready = renderState.status === 'ready'
  // Opening at the top: show paragraphs while the rest of the paper mounts (nothing above can shift).
  // Highlights, citations and the minimap still attach once the whole paper is ready.
  const progressive = !props.initialScrollTop && (renderState.status === 'loading' || renderState.status === 'preparing')
  const resourcesReady = renderState.status === 'preparing' || ready
  const readyRef = React.useRef(ready)
  readyRef.current = ready

  // Scroll sync: lead with the block at the reading line, follow other views to the same block.
  React.useEffect(() => {
    const pane = paneRef.current
    const channel = props.scrollSync
    if (!pane || !channel) return
    const intent = trackScrollIntent(pane)
    scrollIntentRef.current = intent
    const unregister = channel.register((position) => {
      const container = containerRef.current
      const element = blockElementsRef.current.get(position.mappingId)
      if (!container || !element || !readyRef.current) return
      const target = element.offsetTop + position.fraction * element.offsetHeight - container.clientHeight * SYNC_READING_LINE
      intent.markProgrammatic()
      container.scrollTop = Math.max(0, target)
    })
    return () => {
      unregister()
      intent.dispose()
      scrollIntentRef.current = null
    }
  }, [props.scrollSync])
  const mountKey = `${contentRevision}:${renderAttempt}`
  // An in-place change of a fully shown paper (a saved edit, a deleted or restored paragraph) mounts
  // at once: restarting the progressive mount would collapse the page and lose the reading position.
  const completeMountRef = React.useRef<{ attempt: number; length: number } | null>(null)
  // Decided once per revision; later renders of the same revision must not reconsider it.
  const mountDecisionRef = React.useRef<{ key: string; full: boolean; silent: boolean } | null>(null)
  if (mountDecisionRef.current?.key !== mountKey) {
    const complete = completeMountRef.current
    const full = complete !== null && complete.attempt === renderAttempt && Math.abs(complete.length - props.blocks.length) <= 2
    // A shown paper stays shown: no loading cover while one paragraph changes.
    mountDecisionRef.current = { key: mountKey, full, silent: full && renderState.status === 'ready' }
  }
  const [mountProgress, setMountProgress] = React.useState({ key: mountKey, count: MARKDOWN_INITIAL_BLOCKS })
  const mountedCount = Math.min(
    props.blocks.length,
    mountProgress.key === mountKey ? mountProgress.count : mountDecisionRef.current.full ? props.blocks.length : MARKDOWN_INITIAL_BLOCKS
  )
  const allBlocksMounted = mountedCount >= props.blocks.length
  if (allBlocksMounted) completeMountRef.current = { attempt: renderAttempt, length: props.blocks.length }

  const { figureGroupByBlockIndex, figureStates, readyFigureIds, figureMosaics, minimapVisualRevision, figuresSettled, setFigureState } =
    useMarkdownFigures(props.blocks, props.figureGroups, props.pdfUrl)
  const { reorderUnitOf, contentIndexOf, reorderNeighbours } = useReorderUnits(props.blocks, figureGroupByBlockIndex)
  const moveBlocks = React.useCallback((unit: number[], before: number | null) => props.blockMove?.move(unit, before), [props.blockMove])
  const reorderLine = useBlockReorder({ container: containerRef, article: articleRef, enabled: Boolean(props.blockMove) && ready && !blockEditor,
    unitOf: reorderUnitOf, contentIndexOf, onMove: moveBlocks })
  const markMinimapPrepared = React.useCallback(() => {
    setRenderState(previous => previous.status === 'preparing' ? { status: 'ready' } : previous)
  }, [])
  React.useEffect(() => {
    if (ready) onRenderReadyRef.current?.()
  }, [ready])

  const closeTextSelection = React.useCallback((clearBrowser = false) => {
    if (paletteTimerRef.current !== null) {
      window.clearTimeout(paletteTimerRef.current)
      paletteTimerRef.current = null
    }
    setTextSelection(null)
    setPaletteOpen(false)
    if (clearBrowser) clearBrowserTextSelection()
  }, [])

  const releaseScrollSelectionSuppression = React.useCallback(() => {
    if (navigationReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(navigationReleaseFrameRef.current)
    }
    navigationReleaseFrameRef.current = window.requestAnimationFrame(() => {
      navigationReleaseFrameRef.current = window.requestAnimationFrame(() => {
        navigationReleaseFrameRef.current = null
        suppressScrollSelectionRef.current = false
      })
    })
  }, [])

  React.useLayoutEffect(() => {
    const article = articleRef.current
    if (!article) return
    if (!allBlocksMounted) {
      setRenderState({ status: 'loading', completedImages: 0, totalImages: 0 })
      return
    }
    const controller = new AbortController()
    const images = Array.from(article.querySelectorAll<HTMLImageElement>('img'))
    let completedImages = 0
    let timeoutId: number | null = null
    const silent = mountDecisionRef.current?.silent === true

    if (!silent) setRenderState({ status: 'loading', completedImages: 0, totalImages: images.length })

    const render = async (): Promise<void> => {
      try {
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(
            () => reject(new Error('Markdown 资源加载超过 30 秒，请重新加载。')),
            MARKDOWN_RENDER_TIMEOUT_MS
          )
        })
        const assets = Promise.all(images.map(async (image) => {
          try {
            await waitForImage(image, controller.signal)
          } catch (error) {
            // Whole-figure rendering has its own failure fallback; a broken
            // constituent must not reject a successfully prepared PDF crop.
            if (controller.signal.aborted || !image.hasAttribute('data-reader-figure-source')) throw error
          }
          completedImages += 1
          if (!controller.signal.aborted && !silent) {
            setRenderState({ status: 'loading', completedImages, totalImages: images.length })
          }
        }))
        const fonts = document.fonts?.ready ?? Promise.resolve()
        await Promise.race([Promise.all([assets, fonts]), timeout])
        await waitForAnimationFrames(2, controller.signal)
        if (!controller.signal.aborted) {
          if (silent) setLayoutRevision(revision => revision + 1)
          else setRenderState({ status: 'preparing' })
        }
      } catch (error) {
        if (controller.signal.aborted) return
        controller.abort()
        setRenderState({ status: 'error', message: readableRenderError(error) })
      } finally {
        if (timeoutId !== null) window.clearTimeout(timeoutId)
      }
    }

    void render()
    return () => {
      controller.abort()
      if (timeoutId !== null) window.clearTimeout(timeoutId)
    }
  }, [allBlocksMounted, props.assetBaseUrl, contentRevision, renderAttempt])

  React.useEffect(() => {
    if (allBlocksMounted) return
    const frame = window.requestAnimationFrame(() => {
      setMountProgress({ key: mountKey, count: mountedCount + MARKDOWN_BLOCKS_PER_FRAME })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [allBlocksMounted, mountKey, mountedCount])

  const rebuildBlockPositions = React.useCallback(() => {
    const startedAt = performance.now()
    const container = containerRef.current
    if (!container) return
    const positions: BlockPosition[] = []
    let elements = navigationElementsRef.current
    if (elements.length === 0) {
      elements = Array.from(container.querySelectorAll<HTMLElement>('[data-block-ids]'))
      navigationElementsRef.current = elements
      const elementsByMappingId = new Map<string, HTMLElement>()
      const ambiguousMappingIds = new Set<string>()
      for (const element of elements) {
        const mappingIds = parseMappingIds(element.dataset.blockIds)
        for (const mappingId of mappingIds) {
          if (ambiguousMappingIds.has(mappingId)) continue
          const existing = elementsByMappingId.get(mappingId)
          if (existing && existing !== element) {
            elementsByMappingId.delete(mappingId)
            ambiguousMappingIds.add(mappingId)
          } else if (!existing) {
            elementsByMappingId.set(mappingId, element)
          }
        }
      }
      for (const mappingId of ambiguousMappingIds) elementsByMappingId.delete(mappingId)
      ambiguousMappingIdsRef.current = ambiguousMappingIds
      blockElementsRef.current = elementsByMappingId
    }
    const ambiguousMappingIds = ambiguousMappingIdsRef.current
    for (const element of elements) {
      const mappingId = parseMappingIds(element.dataset.blockIds)
        .find((candidate) => !ambiguousMappingIds.has(candidate))
      if (!mappingId) continue
      positions.push({
        mappingId,
        center: element.offsetTop + element.offsetHeight / 2
      })
    }
    blockPositionsRef.current = positions
    setLayoutRevision((revision) => revision + 1)
    recordReaderDuration('markdown-index', startedAt)
  }, [])

  React.useLayoutEffect(() => {
    navigationElementsRef.current = []
    blockElementsRef.current = new Map()
    ambiguousMappingIdsRef.current = new Set()
  }, [contentRevision, renderAttempt, figureStates])

  React.useLayoutEffect(() => {
    if (!props.active || !ready || !articleRef.current || !containerRef.current) return
    const scheduleRebuild = (): void => {
      if (scrollActiveRef.current || minimapDraggingRef.current) {
        resizePendingRef.current = true
        return
      }
      if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current)
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null
        resizePendingRef.current = false
        rebuildBlockPositions()
      })
    }
    rebuildBlockPositions()
    const observer = new ResizeObserver(scheduleRebuild)
    observer.observe(articleRef.current)
    observer.observe(containerRef.current)
    return () => {
      observer.disconnect()
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current)
        resizeFrameRef.current = null
      }
    }
  }, [props.active, ready, rebuildBlockPositions, figureStates])

  React.useLayoutEffect(() => {
    if (!ready || initialScrollAppliedRef.current || !containerRef.current) return
    initialScrollAppliedRef.current = true
    containerRef.current.scrollTop = props.initialScrollTop ?? 0
  }, [props.initialScrollTop, ready])

  React.useLayoutEffect(() => {
    if (!resourcesReady || !figuresSettled || !articleRef.current) return
    const ranges = buildReaderHighlightRanges(articleRef.current, props.annotations)
    setYellowHighlightRanges(ranges.get('copilotix-highlight-yellow') ?? [])
    return registerReaderHighlightRanges(annotationOwner, ranges)
  }, [annotationOwner, props.annotations, props.blocks, resourcesReady, figuresSettled, renderAttempt, figureStates])

  const noteContentKey = React.useMemo(() => ({}), [props.blocks, renderAttempt, figureStates, layoutRevision])
  const noteLayer = useReaderNoteLayer({
    active: props.active,
    ready: resourcesReady && figuresSettled,
    view: props.view,
    notes: props.notes ?? NO_NOTES,
    containerRef,
    articleRef,
    contentKey: noteContentKey,
    onSave: props.onSaveNote,
    onDelete: props.onDeleteNote
  })

  React.useEffect(() => {
    if (!props.active || !ready) {
      closeTextSelection(true)
      return
    }
    const updateSelection = (): void => {
      if (selectionFrameRef.current !== null) window.cancelAnimationFrame(selectionFrameRef.current)
      selectionFrameRef.current = window.requestAnimationFrame(() => {
        selectionFrameRef.current = null
        const article = articleRef.current
        setTextSelection(article ? captureReaderTextSelection(article) : null)
      })
    }
    document.addEventListener('selectionchange', updateSelection)
    return () => document.removeEventListener('selectionchange', updateSelection)
  }, [closeTextSelection, props.active, ready])

  React.useEffect(() => {
    if (!props.active) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeTextSelection(true)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [closeTextSelection, props.active])

  React.useLayoutEffect(() => {
    if (!props.selection) {
      lastNavigatedSelectionRef.current = null
      return
    }
    if (
      !props.active ||
      !ready ||
      props.selection.origin === 'scroll' ||
      !containerRef.current
    ) return
    if (lastNavigatedSelectionRef.current === props.selection) return
    const element = blockElementsRef.current.get(props.selection.mappingId)
    if (!element) return
    lastNavigatedSelectionRef.current = props.selection
    suppressScrollSelectionRef.current = true
    element.scrollIntoView({ behavior: 'auto', block: 'center' })
    releaseScrollSelectionSuppression()
  }, [props.active, props.selection, ready, releaseScrollSelectionSuppression])

  const selectFromMarkdown = React.useCallback((selection: BlockSelection) => {
    if (ambiguousMappingIdsRef.current.has(selection.mappingId)) return
    suppressScrollSelectionRef.current = true
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = null
    }
    props.onSelect(selection)
    releaseScrollSelectionSuppression()
  }, [props.onSelect, releaseScrollSelectionSuppression])

  // The citation index is rebuilt after the edited paper is on screen, not before.
  const citationBlocks = React.useDeferredValue(props.blocks)
  const citationContentKey = React.useMemo(() => ({}), [citationBlocks, renderAttempt, figureStates])
  const citationLayer = useReaderCitationLayer({
    active: props.active,
    ready: resourcesReady && figuresSettled && citationBlocks === props.blocks,
    view: props.view,
    blocks: citationBlocks,
    counterpartBlocks: props.counterpartBlocks,
    containerRef,
    articleRef,
    contentKey: citationContentKey,
    onNavigate: selectFromMarkdown
  })

  const syncScrollSelection = React.useCallback(() => {
    if (suppressScrollSelectionRef.current || minimapDraggingRef.current) return
    const container = containerRef.current
    if (!container) return
    const position = nearestBlockPosition(
      blockPositionsRef.current,
      container.scrollTop + container.clientHeight * 0.35
    )
    if (!position || position.mappingId === lastScrollMappingRef.current) return
    lastScrollMappingRef.current = position.mappingId
    props.onSelect({ mappingId: position.mappingId, origin: 'scroll' })
  }, [props.onSelect])

  const flushDeferredResize = React.useCallback(() => {
    if (!resizePendingRef.current || scrollActiveRef.current || minimapDraggingRef.current) return
    resizePendingRef.current = false
    if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current)
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null
      rebuildBlockPositions()
    })
  }, [rebuildBlockPositions])

  const onMinimapDragStateChange = React.useCallback((dragging: boolean) => {
    minimapDraggingRef.current = dragging
    if (dragging) {
      if (scrollSelectionTimerRef.current !== null) {
        window.clearTimeout(scrollSelectionTimerRef.current)
        scrollSelectionTimerRef.current = null
      }
      return
    }
    syncScrollSelection()
    flushDeferredResize()
  }, [flushDeferredResize, syncScrollSelection])

  const onScroll = React.useCallback(() => {
    if (textSelection) closeTextSelection(true)
    const container = containerRef.current
    if (container) props.onScrollTopChange?.(container.scrollTop)
    if (!props.active || !ready) return
    if (container && props.scrollSync && scrollIntentRef.current?.isUserScroll()) {
      const line = container.scrollTop + container.clientHeight * SYNC_READING_LINE
      const nearest = nearestBlockPosition(blockPositionsRef.current, line)
      const element = nearest ? blockElementsRef.current.get(nearest.mappingId) : undefined
      if (nearest && element) {
        props.scrollSync.report({ mappingId: nearest.mappingId, fraction: clampFraction((line - element.offsetTop) / Math.max(1, element.offsetHeight)) })
      }
    }
    scrollActiveRef.current = true
    if (scrollIdleTimerRef.current !== null) window.clearTimeout(scrollIdleTimerRef.current)
    scrollIdleTimerRef.current = window.setTimeout(() => {
      scrollIdleTimerRef.current = null
      scrollActiveRef.current = false
      flushDeferredResize()
    }, SCROLL_IDLE_DELAY_MS)
    if (suppressScrollSelectionRef.current || minimapDraggingRef.current || scrollSelectionTimerRef.current !== null) return
    scrollSelectionTimerRef.current = window.setTimeout(() => {
      scrollSelectionTimerRef.current = null
      syncScrollSelection()
    }, SCROLL_SELECTION_INTERVAL_MS)
  }, [closeTextSelection, flushDeferredResize, props.active, props.onScrollTopChange, props.scrollSync, ready, syncScrollSelection, textSelection])

  const applyTextAnnotation = React.useCallback((kind: ReaderAnnotationKind) => {
    const article = articleRef.current
    if (!article || !textSelection) return
    const blockTexts = collectAnnotationBlockTexts(article)
    const repaired = props.annotations.map((annotation) => {
      const text = blockTexts.get(annotation.blockKey)
      if (text === undefined) return annotation
      const resolved = resolveReaderAnnotation(text, annotation)
      if (!resolved) return annotation
      return {
        ...annotation,
        startOffset: resolved.startOffset,
        endOffset: resolved.endOffset,
        quote: text.slice(resolved.startOffset, resolved.endOffset),
        prefix: text.slice(Math.max(0, resolved.startOffset - 32), resolved.startOffset),
        suffix: text.slice(resolved.endOffset, resolved.endOffset + 32)
      }
    })
    const next = applyReaderAnnotationOperation({
      existing: repaired,
      taskId: props.taskId,
      view: props.view,
      kind,
      color: kind === 'highlight' ? props.highlightColor : null,
      selections: textSelection.fragments,
      blockTexts,
      createId: () => crypto.randomUUID()
    })
    void props.onReplaceAnnotations(next)
    closeTextSelection(true)
  }, [closeTextSelection, props, textSelection])

  const addToChat = React.useCallback(() => {
    if (!textSelection) return
    props.onAddToChat?.({
      taskId: props.taskId,
      view: props.view,
      text: textSelection.text,
      fragments: textSelection.fragments
    })
    closeTextSelection(true)
  }, [closeTextSelection, props, textSelection])

  const { startNote } = noteLayer
  const writeNote = React.useCallback(() => {
    if (!textSelection) return
    startNote(textSelection)
    closeTextSelection(true)
  }, [closeTextSelection, startNote, textSelection])

  React.useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
    if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current)
    if (scrollSelectionTimerRef.current !== null) window.clearTimeout(scrollSelectionTimerRef.current)
    if (scrollIdleTimerRef.current !== null) window.clearTimeout(scrollIdleTimerRef.current)
    if (navigationReleaseFrameRef.current !== null) window.cancelAnimationFrame(navigationReleaseFrameRef.current)
    if (selectionFrameRef.current !== null) window.cancelAnimationFrame(selectionFrameRef.current)
    if (paletteTimerRef.current !== null) window.clearTimeout(paletteTimerRef.current)
  }, [])

  const retry = React.useCallback(() => {
    setRenderState({ status: 'loading', completedImages: 0, totalImages: 0 })
    setRenderAttempt((value) => value + 1)
  }, [])

  const markFigureRendered = React.useCallback(() => {
    setLayoutRevision((revision) => revision + 1)
  }, [])

  return (
    <div className="markdown-pane" ref={paneRef} data-render-state={renderState.status}>
      <div
        id={documentId}
        className={`markdown-scroll markdown-render-${renderState.status}${progressive ? ' markdown-render-progressive' : ''}`}
        ref={containerRef}
        onScroll={onScroll}
        aria-busy={!ready}
        data-render-state={renderState.status}
      >
        <MarkdownRenderStatus state={renderState} progressive={progressive} mounted={allBlocksMounted ? null : { count: mountedCount, total: props.blocks.length }} onRetry={retry} />
        <article
          key={renderAttempt}
          ref={articleRef}
          className="markdown-body"
          aria-hidden={!ready}
        >
          {props.blocks.slice(0, mountedCount).map((block, index) => {
            const blockId = block.mappingIds[0] ?? `markdown-${index}`
            const figureGroups = figureGroupByBlockIndex.get(index)
            const editKey = props.blockEditing ? block.annotationKey : undefined
            const editingThis = editKey !== undefined && blockEditor?.key === editKey
            return (
              <MarkdownBlockView
                // Stable keys: deleting or restoring a paragraph must not remount the blocks after it.
                key={block.annotationKey ?? `${blockId}-${index}`}
                block={block}
                referenceSection={referenceSections.has(index)}
                active={props.selection !== null && (figureGroups
                  ? figureGroups.some(group => group.ownerBlockIndex === index && group.mappingIds.includes(props.selection!.mappingId))
                  : block.mappingIds.includes(props.selection.mappingId))}
                assetBaseUrl={props.assetBaseUrl}
                pdfUrl={props.pdfUrl}
                figureGroups={figureGroups}
                readyFigureIds={figureGroups ? readyFigureIds : NO_READY_FIGURES}
                figureMosaics={figureGroups ? figureMosaics : NO_MOSAICS}
                onFigureStateChange={setFigureState}
                onEditRequest={editKey && block.role === 'content' && !editingThis ? requestBlockEdit : undefined}
                onBlockMenu={props.blockMenu && !editingThis ? openBlockMenu : undefined}
                editor={editingThis ? <ReaderBlockEditor block={block} editing={props.blockEditing!} typography={blockEditor!.typography} onClose={closeBlockEditor} /> : undefined}
                blockIndex={index}
                onFigureRendered={markFigureRendered}
                onSelect={selectFromMarkdown}
              />
            )
          })}
        </article>
        {props.active && ready && textSelection ? createPortal(
          <ReaderAnnotationToolbar
            selection={textSelection}
            color={props.highlightColor}
            paletteOpen={paletteOpen}
            onPaletteOpen={() => setPaletteOpen(true)}
            onPaletteClose={() => setPaletteOpen(false)}
            onPaletteHover={() => {
              if (paletteTimerRef.current !== null) window.clearTimeout(paletteTimerRef.current)
              paletteTimerRef.current = window.setTimeout(() => setPaletteOpen(true), 250)
            }}
            onPaletteHoverEnd={() => {
              if (paletteTimerRef.current !== null) window.clearTimeout(paletteTimerRef.current)
              paletteTimerRef.current = null
            }}
            onColorChange={props.onHighlightColorChange}
            onHighlight={() => applyTextAnnotation('highlight')}
            onUnderline={() => applyTextAnnotation('underline')}
            onAddToChat={addToChat}
            onNote={noteLayer.enabled ? writeNote : undefined}
          />,
          document.body
        ) : null}
        {noteLayer.layer}
        {citationLayer}
        {blockMenuAt && props.blockMenu ? (
          <MarkdownBlockMenuPopup at={blockMenuAt} menu={props.blockMenu} blockMove={props.blockMove}
            neighbours={props.blockMove ? reorderNeighbours(props.blocks.indexOf(blockMenuAt.block)) : null} contentIndexOf={contentIndexOf} onClose={closeBlockMenu} />
        ) : null}
        {reorderLine}
      </div>
      <MarkdownMinimap
        active={props.active}
        ready={ready || (resourcesReady && figuresSettled)}
        layoutRevision={layoutRevision}
        visualRevision={minimapVisualRevision}
        controlledId={documentId}
        scrollerRef={containerRef}
        articleRef={articleRef}
        yellowHighlightRanges={yellowHighlightRanges}
        onDragStateChange={onMinimapDragStateChange}
        onPrepared={markMinimapPrepared}
      />
    </div>
  )
}
