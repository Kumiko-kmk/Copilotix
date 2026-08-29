import React from 'react'
import { Alert, Button, Spin } from 'antd'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import type { ReaderBlock } from '@shared/readerDocument'
import type { BlockSelection } from '@shared/types'

const MARKDOWN_RENDER_TIMEOUT_MS = 30_000

type RenderState =
  | { status: 'loading'; completedImages: number; totalImages: number }
  | { status: 'ready' }
  | { status: 'error'; message: string }

interface BlockPosition {
  mappingId: string
  center: number
}

const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']]
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), 'blob', 'data', 'mineru-asset']
  }
}

export default function MarkdownPane(props: {
  active: boolean
  blocks: ReaderBlock[]
  assetBaseUrl: string
  selection: BlockSelection | null
  onSelect(selection: BlockSelection): void
}): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const articleRef = React.useRef<HTMLElement>(null)
  const scrollFrameRef = React.useRef<number | null>(null)
  const resizeFrameRef = React.useRef<number | null>(null)
  const navigationReleaseFrameRef = React.useRef<number | null>(null)
  const suppressScrollSelectionRef = React.useRef(false)
  const blockPositionsRef = React.useRef<BlockPosition[]>([])
  const blockElementsRef = React.useRef<Map<string, HTMLElement>>(new Map())
  const ambiguousMappingIdsRef = React.useRef<Set<string>>(new Set())
  const [renderAttempt, setRenderAttempt] = React.useState(0)
  const [renderState, setRenderState] = React.useState<RenderState>({
    status: 'loading',
    completedImages: 0,
    totalImages: 0
  })
  const ready = renderState.status === 'ready'

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
        if (!controller.signal.aborted) setRenderState({ status: 'ready' })
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
  }, [props.assetBaseUrl, props.blocks, renderAttempt])

  const rebuildBlockPositions = React.useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const containerRect = container.getBoundingClientRect()
    const positions: BlockPosition[] = []
    const elementsByMappingId = new Map<string, HTMLElement>()
    const ambiguousMappingIds = new Set<string>()
    const elements = Array.from(container.querySelectorAll<HTMLElement>('[data-block-ids]'))
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
    for (const element of elements) {
      const mappingId = parseMappingIds(element.dataset.blockIds)
        .find((candidate) => !ambiguousMappingIds.has(candidate))
      if (!mappingId) continue
      const rect = element.getBoundingClientRect()
      positions.push({
        mappingId,
        center: rect.top - containerRect.top + container.scrollTop + rect.height / 2
      })
    }
    ambiguousMappingIdsRef.current = ambiguousMappingIds
    blockElementsRef.current = elementsByMappingId
    blockPositionsRef.current = positions.sort((left, right) => left.center - right.center)
  }, [])

  React.useLayoutEffect(() => {
    if (!props.active || !ready || !articleRef.current || !containerRef.current) return
    const scheduleRebuild = (): void => {
      if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current)
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null
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
    if (
      !props.active ||
      !ready ||
      !props.selection ||
      props.selection.origin === 'scroll' ||
      !containerRef.current
    ) return
    const element = blockElementsRef.current.get(props.selection.mappingId)
    if (!element) return
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

  const onScroll = React.useCallback(() => {
    if (!props.active || !ready || suppressScrollSelectionRef.current || scrollFrameRef.current !== null) return
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null
      if (suppressScrollSelectionRef.current) return
      const container = containerRef.current
      if (!container) return
      const position = nearestBlockPosition(
        blockPositionsRef.current,
        container.scrollTop + container.clientHeight * 0.35
      )
      if (position && (position.mappingId !== props.selection?.mappingId || props.selection?.origin !== 'scroll')) {
        props.onSelect({ mappingId: position.mappingId, origin: 'scroll' })
      }
    })
  }, [props.active, props.onSelect, props.selection, ready])

  React.useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
    if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current)
    if (navigationReleaseFrameRef.current !== null) window.cancelAnimationFrame(navigationReleaseFrameRef.current)
  }, [])

  const retry = React.useCallback(() => {
    setRenderState({ status: 'loading', completedImages: 0, totalImages: 0 })
    setRenderAttempt((value) => value + 1)
  }, [])

  return (
    <div
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
        {props.blocks.map((block, index) => {
          const blockId = block.mappingIds[0] ?? `markdown-${index}`
          return (
            <MarkdownBlockView
              key={`${blockId}-${index}`}
              block={block}
              active={props.selection !== null && block.mappingIds.includes(props.selection.mappingId)}
              assetBaseUrl={props.assetBaseUrl}
              onSelect={selectFromMarkdown}
            />
          )
        })}
      </article>
    </div>
  )
}

const MarkdownBlockView = React.memo(function MarkdownBlockView(props: {
  block: ReaderBlock
  active: boolean
  assetBaseUrl: string
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
        className={'markdown-supplemental markdown-supplemental-' + props.block.role}
      >
        <MarkdownContent markdown={props.block.text ?? ''} assetBaseUrl={props.assetBaseUrl} />
      </div>
    )
  }

  return (
    <div
      data-block-ids={props.block.mappingIds.join(' ')}
      data-reader-role={props.block.role}
      className={props.active ? 'markdown-block active' : 'markdown-block'}
      onClick={() => {
        const mappingId = props.block.mappingIds[0]
        if (mappingId) props.onSelect({ mappingId, origin: 'markdown' })
      }}
    >
      <MarkdownContent markdown={props.block.markdown} assetBaseUrl={props.assetBaseUrl} />
    </div>
  )
})

const MarkdownContent = React.memo(function MarkdownContent(props: {
  markdown: string
  assetBaseUrl: string
}): React.JSX.Element {
  const components = React.useMemo<Components>(() => ({
    img: ({ src, alt, width, height }) => (
      <img
        src={resolveAsset(src, props.assetBaseUrl)}
        alt={alt ?? ''}
        width={width}
        height={height}
        loading="eager"
        decoding="async"
      />
    ),
    a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>
  }), [props.assetBaseUrl])

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[
        rehypeRaw,
        [rehypeSanitize, markdownSanitizeSchema],
        [rehypeKatex, { trust: false, throwOnError: false, strict: 'ignore' }]
      ]}
      components={components}
    >
      {props.markdown}
    </ReactMarkdown>
  )
})

function parseMappingIds(value: string | undefined): string[] {
  return value?.split(/\s+/).filter(Boolean) ?? []
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

function resolveAsset(src: string | undefined, base: string): string | undefined {
  if (!src || /^(https?:|data:|blob:|mineru-asset:)/i.test(src)) return src
  return new URL(src.replace(/^\.\//, ''), base).toString()
}
