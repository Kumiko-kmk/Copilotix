import SafeMarkdown, { resolveAsset } from './SafeMarkdown'
import React from 'react'
import { createPortal } from 'react-dom'
import { Alert, Button, Spin } from 'antd'
import { HighlightOutlined, MessageOutlined, UnderlineOutlined } from '@ant-design/icons'
import 'katex/dist/katex.min.css'
import type { ReaderBlock } from '@shared/readerDocument'
import {
  applyReaderAnnotationOperation,
  READER_HIGHLIGHT_COLORS,
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
import ReaderFigureSnapshot from './ReaderFigureSnapshot'
import type { ReaderFigureGroup } from '../readerFigureGroups'
import { recordReaderDuration } from '../readerPerformance'

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
  | { status: 'ready' }
  | { status: 'error'; message: string }

interface BlockPosition {
  mappingId: string
  center: number
}


export default function MarkdownPane(props: {
  active: boolean
  blocks: ReaderBlock[]
  assetBaseUrl: string
  pdfUrl?: string
  figureGroups?: ReaderFigureGroup[]
  taskId: string
  view: ReaderAnnotationView
  annotations: ReaderAnnotation[]
  highlightColor: HighlightColor
  onHighlightColorChange(color: HighlightColor): void
  onReplaceAnnotations(annotations: ReaderAnnotation[]): Promise<void>
  onAddToChat?(selection: ReaderChatSelection): void
  selection: BlockSelection | null
  onSelect(selection: BlockSelection): void
  onRenderReady?(): void
  initialScrollTop?: number
  onScrollTopChange?(scrollTop: number): void
}): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement>(null)
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
  const mountKey = `${contentRevision}:${renderAttempt}`
  const [mountProgress, setMountProgress] = React.useState({ key: mountKey, count: MARKDOWN_INITIAL_BLOCKS })
  const mountedCount = Math.min(
    props.blocks.length,
    mountProgress.key === mountKey ? mountProgress.count : MARKDOWN_INITIAL_BLOCKS
  )
  const allBlocksMounted = mountedCount >= props.blocks.length
  const figureGroupByBlockIndex = React.useMemo(() => {
    const result = new Map<number, ReaderFigureGroup>()
    for (const group of props.figureGroups ?? []) {
      for (const index of group.memberBlockIndexes) result.set(index, group)
    }
    return result
  }, [props.figureGroups])

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
          await waitForImage(image, controller.signal)
          completedImages += 1
          if (!controller.signal.aborted) {
            setRenderState({ status: 'loading', completedImages, totalImages: images.length })
          }
        }))
        const fonts = document.fonts?.ready ?? Promise.resolve()
        await Promise.race([Promise.all([assets, fonts]), timeout])
        await waitForAnimationFrames(2, controller.signal)
        if (!controller.signal.aborted) {
          setRenderState({ status: 'ready' })
          onRenderReadyRef.current?.()
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
  }, [contentRevision, renderAttempt])

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
  }, [props.active, ready, rebuildBlockPositions])

  React.useLayoutEffect(() => {
    if (!ready || initialScrollAppliedRef.current || !containerRef.current) return
    initialScrollAppliedRef.current = true
    containerRef.current.scrollTop = props.initialScrollTop ?? 0
  }, [props.initialScrollTop, ready])

  React.useLayoutEffect(() => {
    if (!ready || !articleRef.current) return
    const ranges = buildReaderHighlightRanges(articleRef.current, props.annotations)
    setYellowHighlightRanges(ranges.get('copilotix-highlight-yellow') ?? [])
    return registerReaderHighlightRanges(annotationOwner, ranges)
  }, [annotationOwner, props.annotations, props.blocks, ready, renderAttempt])

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
  }, [closeTextSelection, flushDeferredResize, props.active, props.onScrollTopChange, ready, syncScrollSelection, textSelection])

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
    <div className="markdown-pane">
      <div
        id={documentId}
        className={`markdown-scroll markdown-render-${renderState.status}`}
        ref={containerRef}
        onScroll={onScroll}
        aria-busy={!ready}
        data-render-state={renderState.status}
      >
        {renderState.status === 'loading' ? (
          <div className="markdown-render-status" role="status">
            <Spin size="large" />
            <span>正在渲染 Markdown…</span>
            {!allBlocksMounted ? <small>段落 {mountedCount} / {props.blocks.length}</small> : null}
            {renderState.totalImages > 0 ? (
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
            const figureGroup = figureGroupByBlockIndex.get(index)
            return (
              <MarkdownBlockView
                key={`${blockId}-${index}`}
                block={block}
                active={props.selection !== null && (figureGroup
                  ? figureGroup.ownerBlockIndex === index && figureGroup.mappingIds.includes(props.selection.mappingId)
                  : block.mappingIds.includes(props.selection.mappingId))}
                assetBaseUrl={props.assetBaseUrl}
                pdfUrl={props.pdfUrl}
                figureGroup={figureGroup}
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
          />,
          document.body
        ) : null}
      </div>
      <MarkdownMinimap
        active={props.active}
        ready={ready}
        layoutRevision={layoutRevision}
        controlledId={documentId}
        scrollerRef={containerRef}
        articleRef={articleRef}
        yellowHighlightRanges={yellowHighlightRanges}
        onDragStateChange={onMinimapDragStateChange}
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
      stringArraysEqual(block.mappingIds, candidate.mappingIds)
  })
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left === right || (left.length === right.length && left.every((value, index) => value === right[index]))
}

const MarkdownBlockView = React.memo(function MarkdownBlockView(props: {
  block: ReaderBlock
  active: boolean
  assetBaseUrl: string
  pdfUrl?: string
  figureGroup?: ReaderFigureGroup
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

  const figureOwner = props.figureGroup?.ownerBlockIndex === props.blockIndex
  const navigationMappingIds = props.figureGroup
    ? figureOwner ? props.figureGroup.mappingIds : []
    : props.block.mappingIds

  return (
    <div
      data-block-ids={navigationMappingIds.join(' ')}
      data-mapping-ids={props.block.mappingIds.join(' ')}
      data-annotation-block-key={props.block.annotationKey}
      data-reader-role={props.block.role}
      className={props.active ? 'markdown-block active' : 'markdown-block'}
      onClick={() => {
        if (window.getSelection() && !window.getSelection()!.isCollapsed) return
        const mappingId = navigationMappingIds[0]
        if (mappingId) props.onSelect({ mappingId, origin: 'markdown' })
      }}
    >
      {props.figureGroup && props.pdfUrl ? (
        <FigureBlockPresentation
          block={props.block}
          blockIndex={props.blockIndex}
          group={props.figureGroup}
          pdfUrl={props.pdfUrl}
          assetBaseUrl={props.assetBaseUrl}
          onRendered={props.onFigureRendered}
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
  group: ReaderFigureGroup
  pdfUrl: string
  assetBaseUrl: string
  onRendered(): void
}): React.JSX.Element {
  const isOwner = props.blockIndex === props.group.ownerBlockIndex
  const isCaption = props.blockIndex === props.group.captionBlockIndex
  const hiddenMarkdown = stripMarkdownImages(isCaption ? props.group.captionPrefixMarkdown : props.block.markdown)
  return (
    <>
      {hiddenMarkdown ? (
        <div className="reader-figure-hidden-source" aria-hidden="true">
          <SafeMarkdown markdown={hiddenMarkdown} assetBaseUrl={props.assetBaseUrl} />
        </div>
      ) : null}
      {isOwner ? (
        <ReaderFigureSnapshot
          pdfUrl={props.pdfUrl}
          group={props.group}
          onRendered={props.onRendered}
          fallback={(
            <div className="reader-figure-fallback">
              <div className="reader-figure-fallback-images">
                {props.group.assetSources.map((asset) => (
                  <img key={asset} src={resolveAsset(asset, props.assetBaseUrl)} alt="" />
                ))}
              </div>
              <SafeMarkdown markdown={props.group.fallbackLegendMarkdown} assetBaseUrl={props.assetBaseUrl} />
            </div>
          )}
        />
      ) : null}
      {isCaption ? (
        <div className="reader-figure-caption">
          <SafeMarkdown markdown={props.group.captionMarkdown} assetBaseUrl={props.assetBaseUrl} />
        </div>
      ) : null}
    </>
  )
}

function stripMarkdownImages(markdown: string): string {
  return markdown.replace(/!\[[^\]]*\]\([^)]*\)\s*[\\ ]*/gu, '').trim()
}

const HIGHLIGHT_COLOR_VALUES: Record<HighlightColor, string> = {
  yellow: '#F4C542',
  green: '#67C587',
  blue: '#64A8E8',
  pink: '#E98AB4',
  purple: '#A98BEA'
}

function ReaderAnnotationToolbar(props: {
  selection: ReaderTextSelection
  color: HighlightColor
  paletteOpen: boolean
  onPaletteOpen(): void
  onPaletteClose(): void
  onPaletteHover(): void
  onPaletteHoverEnd(): void
  onColorChange(color: HighlightColor): void
  onHighlight(): void
  onUnderline(): void
  onAddToChat(): void
}): React.JSX.Element {
  const above = props.selection.rect.top >= 92
  const center = props.selection.rect.left + props.selection.rect.width / 2
  const left = Math.max(68, Math.min(window.innerWidth - 68, center))
  const top = above ? props.selection.rect.top - 10 : props.selection.rect.bottom + 10
  return (
    <div
      className={`reader-annotation-toolbar ${above ? 'above' : 'below'}`}
      data-testid="reader-annotation-toolbar"
      style={{ left, top }}
      onMouseDown={(event) => event.preventDefault()}
      role="toolbar"
      aria-label="文本标注"
    >
      {props.paletteOpen ? (
        <div className="reader-highlight-palette" role="listbox" aria-label="荧光笔颜色">
          {READER_HIGHLIGHT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={color === props.color ? 'active' : ''}
              style={{ '--highlight-swatch': HIGHLIGHT_COLOR_VALUES[color] } as React.CSSProperties}
              aria-label={`选择${highlightColorLabel(color)}`}
              aria-selected={color === props.color}
              role="option"
              onClick={() => {
                props.onColorChange(color)
                props.onPaletteClose()
              }}
            />
          ))}
        </div>
      ) : null}
      <button
        type="button"
        aria-label="荧光笔高亮"
        onClick={props.onHighlight}
        onMouseEnter={props.onPaletteHover}
        onMouseLeave={props.onPaletteHoverEnd}
        onContextMenu={(event) => {
          event.preventDefault()
          props.onPaletteOpen()
        }}
      >
        <HighlightOutlined style={{ color: HIGHLIGHT_COLOR_VALUES[props.color] }} />
      </button>
      <button type="button" aria-label="添加下划线" onClick={props.onUnderline}>
        <UnderlineOutlined />
      </button>
      <button type="button" aria-label="添加到对话" onClick={props.onAddToChat}>
        <MessageOutlined />
      </button>
    </div>
  )
}

function highlightColorLabel(color: HighlightColor): string {
  return ({ yellow: '黄色', green: '绿色', blue: '蓝色', pink: '粉色', purple: '紫色' })[color]
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

function readableRenderError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Markdown 资源加载失败，请重新加载。'
}


function parseMappingIds(value: string | undefined): string[] {
  return value?.split(/\s+/).filter(Boolean) ?? []
}
