import React from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeTableMath from '../rehypeTableMath'
import type { Citation } from '@shared/ragSchemas'
import { figureAssetName, isFigureLabel } from '../readerFigureGroups'

const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    th: [...(defaultSchema.attributes?.th ?? []), 'rowSpan', 'colSpan'],
    td: [...(defaultSchema.attributes?.td ?? []), 'rowSpan', 'colSpan']
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), 'blob', 'data', 'copilotix-asset']
  }
}

const SafeMarkdown = React.memo(function SafeMarkdown(props: {
  markdown: string
  assetBaseUrl?: string
  citations?: Record<string, Citation>
  /** Display numbers for verified evidence ids; defaults to the id itself. */
  citationLabels?: Record<string, number>
  onCitation?(citation: Citation): void
  figurePresentation?: { assets: string[]; hiddenTexts: string[]; ready: boolean }
}): React.JSX.Element {
  const markdown = props.citations ? props.markdown.replace(/\[(E\d+)\]/gu, (marker, id: string) => props.citations?.[id] ? `[${id}](#paper-evidence-${id})` : marker) : props.markdown
  const components = React.useMemo<Components>(() => ({
    img: ({ src, alt, width, height }) => {
      const figureAsset = Boolean(src && props.figurePresentation?.assets.some(asset => figureAssetName(asset) === figureAssetName(src)))
      if (props.citations) return <span>{alt}</span>
      if (figureAsset && props.figurePresentation?.ready) return null
      return (
      <img
        src={resolveAsset(src, props.assetBaseUrl ?? '')}
        alt={alt ?? ''}
        width={width}
        height={height}
        loading="eager"
        decoding="async"
        data-reader-figure-source={figureAsset || undefined}
      />
      )
    },
    table: ({ node: _node, ...tableProps }) => (
      <div className="markdown-table-scroll">
        <table {...tableProps} />
      </div>
    ),
    a: ({ href, children }) => {
      if (props.citations) {
        const id = href?.match(/^#paper-evidence-(E[1-9]\d*)$/u)?.[1]
        const citation = id ? props.citations[id] : undefined
        if (!citation || !id) return <span>{children}</span>
        const label = props.citationLabels?.[id]
        return (
          <button
            type="button"
            className="paper-chat-citation"
            aria-label={label === undefined ? id : `引用 ${label}`}
            onClick={() => props.onCitation?.(citation)}
          >
            {label ?? children}
          </button>
        )
      }
      return <a href={href} target="_blank" rel="noreferrer">{children}</a>
    }
  }), [props.assetBaseUrl, props.citationLabels, props.citations, props.onCitation, props.figurePresentation])

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[
        rehypeRaw,
        [rehypeSanitize, markdownSanitizeSchema],
        rehypeTableMath,
        [rehypeKatex, { trust: false, throwOnError: false, strict: 'ignore' }],
        removeHoverTitles,
        [hideFigureText, props.figurePresentation]
      ]}
      components={components}
    >
      {markdown}
    </ReactMarkdown>
  )
})

export default SafeMarkdown

type MarkdownNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: MarkdownNode[] }

/** Keep source text in the DOM so annotation offsets survive the presentation
 * switch. Only whole matching labels/legend nodes are visually hidden. */
function hideFigureText(presentation?: { assets: string[]; hiddenTexts: string[]; ready: boolean }) {
  const normalized = new Set((presentation?.hiddenTexts ?? []).map(text => text.replace(/\s+/gu, '').trim()).filter(Boolean))
  const normalize = (value: string): string => value.replace(/\s+/gu, '').trim()
  const ownedImage = (node: MarkdownNode): boolean => node.tagName === 'img' && typeof node.properties?.src === 'string' &&
    Boolean(presentation?.assets.some(asset => figureAssetName(asset) === figureAssetName(node.properties!.src as string)))
  const hiddenText = (value: string): boolean => normalized.has(normalize(value)) || (normalized.size > 0 && isFigureLabel(value))
  const onlyFigure = (node: MarkdownNode): boolean => node.type === 'text' ? !node.value?.trim() || hiddenText(node.value) :
    ownedImage(node) || node.tagName === 'br' || Boolean(node.children?.length && node.children.every(onlyFigure))
  return (tree: MarkdownNode): void => {
    if (!presentation?.ready) return
    const visit = (node: MarkdownNode): void => {
      if (!node.children || node.tagName === 'code' || node.tagName === 'pre') return
      if (node.tagName === 'p' && node.children.every(onlyFigure)) {
        node.properties = { ...node.properties, className: ['reader-figure-hidden-source'], 'aria-hidden': 'true' }
        return
      }
      node.children = node.children.map(child => {
        if (child.type === 'text' && child.value?.trim() && hiddenText(child.value)) {
          return { type: 'element', tagName: 'span', properties: { className: ['reader-figure-hidden-source'], 'aria-hidden': 'true' }, children: [child] }
        }
        visit(child)
        return child
      })
    }
    visit(tree)
  }
}

/** Remove native hover hints from imported HTML and generated formula markup at display time. */
function removeHoverTitles() {
  return (tree: MarkdownNode): void => {
    const pending = [tree]
    while (pending.length) {
      const node = pending.pop()!
      if (node.properties) delete node.properties.title
      if (node.children) pending.push(...node.children)
    }
  }
}

export function resolveAsset(src: string | undefined, base: string): string | undefined {
  if (!src || /^(https?:|data:|blob:|copilotix-asset:)/i.test(src)) return src
  return new URL(src.replace(/^\.\//, ''), base).toString()
}
