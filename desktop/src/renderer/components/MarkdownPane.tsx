import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type { BlockMapping } from '@shared/types'
import { splitMarkdownBlocks } from '../markdownBlocks'

export default function MarkdownPane(props: {
  markdown: string
  mappings: BlockMapping[]
  assetBaseUrl: string
  activeBlockId: string | null
  onActiveBlock(blockId: string): void
}): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const scrollFrame = React.useRef<number | null>(null)
  const blocks = React.useMemo(() => splitMarkdownBlocks(props.markdown), [props.markdown])

  React.useEffect(() => {
    if (!props.activeBlockId || !containerRef.current) return
    const element = containerRef.current.querySelector<HTMLElement>(`[data-block-id="${props.activeBlockId}"]`)
    if (!element) return
    const parentRect = containerRef.current.getBoundingClientRect()
    const rect = element.getBoundingClientRect()
    if (rect.top < parentRect.top || rect.bottom > parentRect.bottom) element.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [props.activeBlockId])

  const onScroll = React.useCallback(() => {
    if (scrollFrame.current !== null) return
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = null
    const container = containerRef.current
    if (!container) return
    const center = container.getBoundingClientRect().top + container.clientHeight * 0.35
    let best: { id: string; distance: number } | null = null
    for (const element of container.querySelectorAll<HTMLElement>('[data-block-id]')) {
      const id = element.dataset.blockId
      if (!id) continue
      const rect = element.getBoundingClientRect()
      const distance = Math.abs(rect.top + rect.height / 2 - center)
      if (!best || distance < best.distance) best = { id, distance }
    }
    if (best && best.id !== props.activeBlockId) props.onActiveBlock(best.id)
    })
  }, [props])

  React.useEffect(() => () => {
    if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current)
  }, [])

  return (
    <div className="markdown-scroll" ref={containerRef} onScroll={onScroll}>
      <article className="markdown-body">
        {blocks.map((block, index) => {
          const blockId = props.mappings[index]?.id ?? `markdown-${index}`
          return (
            <div
              key={blockId}
              data-block-id={blockId}
              className={props.activeBlockId === blockId ? 'markdown-block active' : 'markdown-block'}
              onClick={() => props.onActiveBlock(blockId)}
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                components={{
                  img: ({ src, alt }) => <img src={resolveAsset(src, props.assetBaseUrl)} alt={alt ?? ''} loading="lazy" />,
                  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>
                }}
              >
                {block}
              </ReactMarkdown>
            </div>
          )
        })}
      </article>
    </div>
  )
}

function resolveAsset(src: string | undefined, base: string): string | undefined {
  if (!src || /^(https?:|data:|blob:|mineru-asset:)/i.test(src)) return src
  return new URL(src.replace(/^\.\//, ''), base).toString()
}
