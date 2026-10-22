import SafeMarkdown from './SafeMarkdown'
import React from 'react'
import { createPortal } from 'react-dom'
import { Alert, Button, Spin } from 'antd'
import type { ReaderBlock } from '@shared/readerDocument'
import {
  applyReaderAnnotationOperation,
  resolveReaderAnnotation
} from '@shared/readerAnnotations'
import type {
  BlockSelection,
  HighlightColor,
  ReaderAnnotation,
  ReaderAnnotationKind,
  ReaderAnnotationView,
  ReaderChatSelection
} from '@shared/types'
import {
  buildReaderHighlightRanges,
  captureReaderTextSelection,
  clearBrowserTextSelection,
  collectAnnotationBlockTexts,
  registerReaderHighlightRanges,
  type ReaderTextSelection
} from '../readerAnnotations'
import MarkdownMinimap from './MarkdownMinimap'
import ReaderFigureSnapshot, { type FigureRenderState } from './ReaderFigureSnapshot'
import ReaderFigureMosaic from './ReaderFigureMosaic'
import { figureMosaic, type FigureMosaic } from '../readerFigureMosaic'
import { figureAssetName, markdownAssetSources, type ReaderFigureGroup } from '@shared/readerFigureGroups'
import { recordReaderDuration } from '../readerPerformance'
import { SYNC_READING_LINE, clampFraction, trackScrollIntent, type ScrollIntent, type ScrollSyncChannel } from '../readerScrollSync'
import { readerReferenceSections } from '../readerReferenceSections'
import { useReaderNoteLayer } from './ReaderNotes'
import { useReaderCitationLayer } from './ReaderCitations'
import ReaderAnnotationToolbar from './ReaderAnnotationToolbar'
import type { ReaderNote } from '@shared/readerNotes'
import { TRANSLATION_PROVIDER_LABELS } from '@shared/providerPolicy'

const MARKDOWN_RENDER_TIMEOUT_MS = 30_000
/**
 * Long papers mount their blocks over several frames so opening one never
 * freezes the window. Short documents still mount in a single commit.
 */
export const MARKDOWN_INITIAL_BLOCKS = 80
export const MARKDOWN_BLOCKS_PER_FRAME = 40
const SCROLL_SELECTION_INTERVAL_MS = 80
const SCROLL_IDLE_DELAY_MS = 120

type RenderState =
  | { status: 'loading'; completedImages: number; totalImages: number }
  | { status: 'preparing' }
  | { status: 'ready' }
  | { status: 'error'; message: string }

interface BlockPosition {
  mappingId: string
  center: number
}


export default function MarkdownPane(props: {
  active: boolean
  blocks: ReaderBlock[]
  /** The other reading view's blocks: a cited entry also shows its text there when it differs. */
  counterpartBlocks?: ReaderBlock[]
  assetBaseUrl: string
  pdfUrl?: string
  figureGroups?: ReaderFigureGroup[]
  onOpenFigurePdf?(selection: BlockSelection): void
  /** "加入问答" on each figure; omitted where figures cannot be asked about. */
  figureChat?: ReaderFigureChat
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
  const [mountProgress, setMountProgress] = React.useState({ key: mountKey, count: MARKDOWN_INITIAL_BLOCKS })
  const mountedCount = Math.min(
    props.blocks.length,
    mountProgress.key === mountKey ? mountProgress.count : MARKDOWN_INITIAL_BLOCKS
  )
  const allBlocksMounted = mountedCount >= props.blocks.length
  const figureGroupByBlockIndex = React.useMemo(() => {
    const result = new Map<number, ReaderFigureGroup[]>()
    for (const group of props.figureGroups ?? []) {
      for (const index of group.memberBlockIndexes) result.set(index, [...(result.get(index) ?? []), group])
    }
    return result
  }, [props.figureGroups])
  const figureRevision = contentRevision + '|' + props.pdfUrl
  const [figureStates, setFigureStates] = React.useState<{ revision: string; states: Record<string, FigureRenderState> }>({ revision: figureRevision, states: {} })
  const readyFigureKey = figureStates.revision === figureRevision
    ? Object.keys(figureStates.states).filter(id => figureStates.states[id] === 'ready').sort().join('\0') : ''
  const readyFigureIds = React.useMemo(() => new Set(readyFigureKey ? readyFigureKey.split('\0') : []), [readyFigureKey])
  const failedFigureKey = figureStates.revision === figureRevision
    ? Object.keys(figureStates.states).filter(id => figureStates.states[id] === 'failed').sort().join('\0') : ''
  // A figure without a PDF crop (unconfirmed, or its crop failed) keeps side-by-side panels
  // where the PDF puts them instead of one image per line (readerFigureMosaic.ts).
  const figureMosaics = React.useMemo(() => {
    const failed = new Set(failedFigureKey ? failedFigureKey.split('\0') : [])
    const groups = props.figureGroups ?? []
    const result = new Map<string, FigureMosaic>()
    for (const group of groups) {
      if (group.status === 'complete' && !failed.has(group.id)) continue
      // A panel claimed by two figures is shown once, in its own paragraph.
      const names = new Set(group.assetSources.map(figureAssetName))
      if (groups.some(other => other !== group && other.assetSources.some(asset => names.has(figureAssetName(asset))))) continue
      const mosaic = figureMosaic(group, group.memberBlockIndexes.flatMap(index => markdownAssetSources(props.blocks[index]?.markdown ?? '')))
      if (mosaic) result.set(group.id, mosaic)
    }
    return result
  }, [props.figureGroups, props.blocks, failedFigureKey])
  const minimapVisualRevision = React.useMemo(() => JSON.stringify([
    figureRevision, [...readyFigureIds], [...figureMosaics.keys()]
  ]), [figureRevision, readyFigureIds, figureMosaics])
  const figuresSettled = !props.pdfUrl || Array.from(figureGroupByBlockIndex.entries()).every(([index, groups]) => groups.every(group =>
    group.status !== 'complete' || group.ownerBlockIndex !== index || props.blocks[index]?.role !== 'content' ||
    (figureStates.revision === figureRevision &&
      (figureStates.states[group.id] === 'ready' || figureStates.states[group.id] === 'failed'))
  ))
  const markMinimapPrepared = React.useCallback(() => {
    setRenderState(previous => previous.status === 'preparing' ? { status: 'ready' } : previous)
  }, [])
  React.useEffect(() => {
    if (ready) onRenderReadyRef.current?.()
  }, [ready])
  const setFigureState = React.useCallback((id: string, state: FigureRenderState) => {
    setFigureStates(previous => {
      const states = previous.revision === figureRevision ? previous.states : {}
      return states[id] === state && previous.revision === figureRevision ? previous : { revision: figureRevision, states: { ...states, [id]: state } }
    })
  }, [figureRevision])

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

    setRenderState({ status: 'loading', completedImages: 0, totalImages: images.length })

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
          if (!controller.signal.aborted) {
            setRenderState({ status: 'loading', completedImages, totalImages: images.length })
          }
        }))
        const fonts = document.fonts?.ready ?? Promise.resolve()
        await Promise.race([Promise.all([assets, fonts]), timeout])
        await waitForAnimationFrames(2, controller.signal)
        if (!controller.signal.aborted) {
          setRenderState({ status: 'preparing' })
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

  const citationContentKey = React.useMemo(() => ({}), [props.blocks, renderAttempt, figureStates])
  const citationLayer = useReaderCitationLayer({
    active: props.active,
    ready: resourcesReady && figuresSettled,
    view: props.view,
    blocks: props.blocks,
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
        className={`markdown-scroll markdown-render-${renderState.status}`}
        ref={containerRef}
        onScroll={onScroll}
        aria-busy={!ready}
        data-render-state={renderState.status}
      >
        {renderState.status === 'loading' || renderState.status === 'preparing' ? (
          <div className="markdown-render-status" role="status">
            <Spin size="large" />
            <span>正在渲染 Markdown…</span>
            {!allBlocksMounted ? <small>段落 {mountedCount} / {props.blocks.length}</small> : null}
            {renderState.status === 'loading' && renderState.totalImages > 0 ? (
              <small>图片 {renderState.completedImages} / {renderState.totalImages}</small>
            ) : null}
          </div>
        ) : null}
        {renderState.status === 'error' ? (
          <div className="markdown-render-status">
            <Alert
              type="error"
              showIcon
              message="Markdown 无法完整显示"
              description={renderState.message}
              action={<Button onClick={retry}>重新加载</Button>}
            />
          </div>
        ) : null}
        <article
          key={renderAttempt}
          ref={articleRef}
          className="markdown-body"
          aria-hidden={!ready}
        >
          {props.blocks.slice(0, mountedCount).map((block, index) => {
            const blockId = block.mappingIds[0] ?? `markdown-${index}`
            const figureGroups = figureGroupByBlockIndex.get(index)
            return (
              <MarkdownBlockView
                key={`${blockId}-${index}`}
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
                onOpenFigurePdf={props.onOpenFigurePdf}
                figureChat={figureGroups ? props.figureChat : undefined}
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

function readerBlocksEqual(left: ReaderBlock[], right: ReaderBlock[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((block, index) => {
    const candidate = right[index]
    return candidate !== undefined &&
      block.role === candidate.role &&
      block.markdown === candidate.markdown &&
      block.annotationKey === candidate.annotationKey &&
      block.text === candidate.text &&
      block.pageIndex === candidate.pageIndex &&
      block.order === candidate.order &&
      block.fallbackProvider === candidate.fallbackProvider &&
      block.sourceChanged === candidate.sourceChanged &&
      stringArraysEqual(block.mappingIds, candidate.mappingIds)
  })
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left === right || (left.length === right.length && left.every((value, index) => value === right[index]))
}

/** Adds a figure to the chat composer. `blocked` explains why the current model cannot take images. */
export interface ReaderFigureChat {
  blocked: string | null
  onAdd(group: ReaderFigureGroup): void
}

const NO_READY_FIGURES: ReadonlySet<string> = new Set()
const NO_NOTES: readonly ReaderNote[] = []
const NO_MOSAICS: ReadonlyMap<string, FigureMosaic> = new Map()
const MarkdownBlockView = React.memo(function MarkdownBlockView(props: {
  block: ReaderBlock
  referenceSection: boolean
  active: boolean
  assetBaseUrl: string
  pdfUrl?: string
  figureGroups?: ReaderFigureGroup[]
  readyFigureIds: ReadonlySet<string>
  figureMosaics: ReadonlyMap<string, FigureMosaic>
  onFigureStateChange(id: string, state: FigureRenderState): void
  onOpenFigurePdf?(selection: BlockSelection): void
  figureChat?: ReaderFigureChat
  blockIndex: number
  onFigureRendered(): void
  onSelect(selection: BlockSelection): void
}): React.JSX.Element {
  if (props.block.role === 'page-divider') {
    return (
      <div
        className="reader-page-divider"
        data-reader-role="page-divider"
        data-page-index={props.block.pageIndex}
      >
        <span>{props.block.text}</span>
      </div>
    )
  }

  const supplemental = props.block.role !== 'content'
  if (supplemental) {
    return (
      <div
        data-reader-role={props.block.role}
        data-annotation-block-key={props.block.annotationKey}
        data-page-index={props.block.pageIndex}
        className={'markdown-supplemental markdown-supplemental-' + props.block.role}
      >
        <SafeMarkdown markdown={props.block.text ?? ''} assetBaseUrl={props.assetBaseUrl} />
      </div>
    )
  }

  const readyGroups = props.figureGroups?.filter(group => group.status === 'complete' && props.readyFigureIds.has(group.id)) ?? []
  const navigationMappingIds = [...new Set([...readyGroups.filter(group => group.ownerBlockIndex === props.blockIndex).flatMap(group => group.mappingIds),
    ...props.block.mappingIds.filter(id => !readyGroups.some(group => group.mappingIds.includes(id)))])]

  return (
    <div
      data-block-ids={navigationMappingIds.join(' ')}
      data-reader-block-index={props.blockIndex}
      data-mapping-ids={props.block.mappingIds.join(' ')}
      data-annotation-block-key={props.block.annotationKey}
      data-reader-role={props.block.role}
      data-fallback-provider={props.block.fallbackProvider}
      data-source-changed={props.block.sourceChanged ? '' : undefined}
      data-fallback-label={blockNoteLabel(props.block)}
      className={'markdown-block' + (props.active ? ' active' : '') + (props.referenceSection ? ' reader-references' : '')}
      onClick={() => {
        if (window.getSelection() && !window.getSelection()!.isCollapsed) return
        const mappingId = navigationMappingIds[0]
        if (mappingId) props.onSelect({ mappingId, origin: 'markdown' })
      }}
    >
      {props.figureGroups && props.pdfUrl ? (
        <FigureBlockPresentation
          block={props.block}
          blockIndex={props.blockIndex}
          groups={props.figureGroups}
          pdfUrl={props.pdfUrl}
          assetBaseUrl={props.assetBaseUrl}
          onRendered={props.onFigureRendered}
          readyFigureIds={props.readyFigureIds}
          mosaics={props.figureMosaics}
          onStateChange={props.onFigureStateChange}
          onOpenPdf={props.onOpenFigurePdf}
          figureChat={props.figureChat}
        />
      ) : (
        <SafeMarkdown markdown={props.block.markdown} assetBaseUrl={props.assetBaseUrl} />
      )}
    </div>
  )
})

function FigureBlockPresentation(props: {
  block: ReaderBlock
  blockIndex: number
  groups: ReaderFigureGroup[]
  pdfUrl: string
  assetBaseUrl: string
  onRendered(): void
  readyFigureIds: ReadonlySet<string>
  mosaics: ReadonlyMap<string, FigureMosaic>
  onStateChange(id: string, state: FigureRenderState): void
  onOpenPdf?(selection: BlockSelection): void
  figureChat?: ReaderFigureChat
}): React.JSX.Element {
  const owners = props.groups.filter(group => group.ownerBlockIndex === props.blockIndex)
  const isCaption = props.groups.some(group => props.blockIndex === group.captionBlockIndex)
  const presentation = React.useMemo(() => {
    const ready = props.groups.filter(group => group.status === 'complete' && props.readyFigureIds.has(group.id))
    return {
    // A shared paragraph may contain one caption and another figure's image.
    // Only successful crops can hide their own source assets and graphical text.
    assets: props.groups.flatMap(group => group.assetSources),
    // Panels drawn in a mosaic are hidden in every paragraph that holds them.
    hiddenAssets: [...ready.flatMap(group => group.assetSources),
      ...props.groups.flatMap(group => props.mosaics.get(group.id)?.tiles.map(tile => tile.sourceAsset) ?? [])],
    hiddenTexts: ready.flatMap(group =>
      group.supportingTextsByBlock?.[props.blockIndex] ?? group.members.filter(member => member.kind === 'supporting').map(member => member.sourceText)),
    ready: true
    }
  }, [props.groups, props.blockIndex, props.readyFigureIds, props.mosaics])
  const source = <SafeMarkdown markdown={props.block.markdown} assetBaseUrl={props.assetBaseUrl} figurePresentation={presentation} />
  return (
    <>
      {owners.filter(group => group.status === 'complete').map(group => (
        <ReaderFigureSnapshot
          key={props.pdfUrl + '|' + group.id}
          pdfUrl={props.pdfUrl}
          group={group}
          preRender
          onRendered={props.onRendered}
          onStateChange={state => props.onStateChange(group.id, state)}
        />
      ))}
      {owners.map(group => {
        const mosaic = props.mosaics.get(group.id)
        return mosaic ? <ReaderFigureMosaic key={'mosaic|' + group.id} mosaic={mosaic} assetBaseUrl={props.assetBaseUrl} /> : null
      })}
      {isCaption ? <div className="reader-figure-caption">{source}</div> : source}
      {owners.map(group => {
        const mappingId = group.captionMappingId || group.mappingIds[0]
        const pdf = props.onOpenPdf && mappingId ? (
        <button key={group.id} type="button" className="reader-figure-action" data-reader-annotation-ignore="true"
          onClick={event => {
            event.stopPropagation()
            // The selected mapping retains its stored identity. PDF reveals use
            // that mapping, not a synthetic figure ID.
            props.onOpenPdf?.({ mappingId, blockPosition: group.captionBlockPosition ||
              group.members.find(member => member.mappingId === mappingId)?.blockPosition, origin: 'markdown' })
          }} aria-label={'查看 PDF 第 ' + (group.pageIndex + 1) + ' 页整图'}>
          查看 PDF
        </button>
        ) : null
        const chat = props.figureChat ? (
        // Stays clickable when blocked so the reason can be shown without a hover tooltip.
        <button key={'chat|' + group.id} type="button" className="reader-figure-action reader-figure-chat" data-reader-annotation-ignore="true"
          aria-disabled={props.figureChat.blocked ? true : undefined}
          onClick={event => { event.stopPropagation(); props.figureChat?.onAdd(group) }}
          aria-label={'将第 ' + (group.pageIndex + 1) + ' 页的图加入问答'}>
          加入问答
        </button>
        ) : null
        return pdf || chat ? <React.Fragment key={group.id}>{pdf}{chat}</React.Fragment> : null
      })}
    </>
  )
}

function nearestBlockPosition(positions: BlockPosition[], target: number): BlockPosition | null {
  if (positions.length === 0) return null
  let low = 0
  let high = positions.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const position = positions[middle]
    if (position && position.center < target) low = middle + 1
    else high = middle
  }
  const after = positions[Math.min(low, positions.length - 1)]
  const before = positions[Math.max(0, low - 1)]
  if (!after) return before ?? null
  if (!before) return after
  return Math.abs(after.center - target) < Math.abs(before.center - target) ? after : before
}

async function waitForImage(image: HTMLImageElement, signal: AbortSignal): Promise<void> {
  if (!image.complete) await waitForImageEvent(image, signal)
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  try {
    await image.decode()
  } catch (error) {
    if (!image.complete || image.naturalWidth === 0) throw error
  }
  if (image.naturalWidth === 0) {
    throw new Error(`图片加载失败：${image.currentSrc || image.src || '未知资源'}`)
  }
}

function waitForImageEvent(image: HTMLImageElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      image.removeEventListener('load', onLoad)
      image.removeEventListener('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const onLoad = (): void => {
      cleanup()
      resolve()
    }
    const onError = (): void => {
      cleanup()
      reject(new Error(`图片加载失败：${image.currentSrc || image.src || '未知资源'}`))
    }
    const onAbort = (): void => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    image.addEventListener('load', onLoad, { once: true })
    image.addEventListener('error', onError, { once: true })
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function waitForAnimationFrames(count: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let remaining = count
    const next = (): void => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      remaining -= 1
      if (remaining <= 0) resolve()
      else window.requestAnimationFrame(next)
    }
    window.requestAnimationFrame(next)
  })
}

/** On-page note above a translated block: fallback provider and/or a source that changed after translation. */
function blockNoteLabel(block: ReaderBlock): string | undefined {
  const notes = [
    block.fallbackProvider ? `${TRANSLATION_PROVIDER_LABELS[block.fallbackProvider]} 回退翻译` : null,
    block.sourceChanged ? '原文已修复，译文待更新' : null
  ].filter(Boolean)
  return notes.length ? notes.join(' · ') : undefined
}

function readableRenderError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Markdown 资源加载失败，请重新加载。'
}


function parseMappingIds(value: string | undefined): string[] {
  return value?.split(/\s+/).filter(Boolean) ?? []
}
