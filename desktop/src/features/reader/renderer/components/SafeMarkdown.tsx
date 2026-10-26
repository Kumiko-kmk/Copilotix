import React from 'react'
import { normalizeMathDelimiters } from '@platform/markdown/core/standardMarkdown'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type { PluggableList } from 'unified'
import 'katex/dist/katex.min.css'
import rehypeTableMath from '@platform/markdown/renderer/rehypeTableMath'
import type { Citation } from '@features/chat/contract/ragSchemas'
import { figureAssetName } from '../../core/readerFigureGroups'

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
  figurePresentation?: { assets: string[]; hiddenAssets?: string[]; hiddenTexts: string[]; ready: boolean }
  /** Compact text fields cannot contain block-level HTML or load embedded images. */
  inline?: boolean
  remarkPlugins?: PluggableList
}): React.JSX.Element {
  const prepared = React.useMemo(() => normalizeMathDelimiters(props.markdown), [props.markdown])
  const markdown = props.citations ? prepared.replace(/\[(E\d+)\]/gu, (marker, id: string) => props.citations?.[id] ? `[${id}](#paper-evidence-${id})` : marker) : prepared
  const components = React.useMemo<Components>(() => ({
    img: ({ src, alt, width, height }) => {
      const figureAsset = Boolean(src && props.figurePresentation?.assets.some(asset => figureAssetName(asset) === figureAssetName(src)))
      if (props.citations || props.inline) return <span>{alt}</span>
      if (figureAsset && props.figurePresentation?.ready && (!props.figurePresentation.hiddenAssets ||
        props.figurePresentation.hiddenAssets.some(asset => figureAssetName(asset) === figureAssetName(src!)))) return null
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
    table: ({ node: _node, ...tableProps }) => props.inline ? <span>{tableProps.children}</span> : (
      <div className="markdown-table-scroll">
        <table {...tableProps} />
      </div>
    ),
    ...(props.inline ? inlineComponents : {}),
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
  }), [props.assetBaseUrl, props.citationLabels, props.citations, props.onCitation, props.figurePresentation, props.inline])

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath, ...(props.remarkPlugins ?? [])]}
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

const Inline = ({ children }: { children?: React.ReactNode }): React.JSX.Element => <span>{children}</span>
const inlineComponents: Components = {
  p: Inline, h1: Inline, h2: Inline, h3: Inline, h4: Inline, h5: Inline, h6: Inline,
  blockquote: Inline, ul: Inline, ol: Inline, li: Inline, pre: Inline, div: Inline,
  thead: Inline, tbody: Inline, tr: Inline, td: Inline, th: Inline, hr: () => <br />
}

type MarkdownNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: MarkdownNode[] }

/** Keep source text in the DOM so annotation offsets survive the presentation
 * switch. Only whole matching labels/legend nodes are visually hidden. */
function hideFigureText(presentation?: { assets: string[]; hiddenAssets?: string[]; hiddenTexts: string[]; ready: boolean }) {
  const normalized = new Set((presentation?.hiddenTexts ?? []).map(text => text.replace(/\s+/gu, '').trim()).filter(Boolean))
  const normalize = (value: string): string => value.replace(/\s+/gu, '').trim()
  const ownedImage = (node: MarkdownNode): boolean => node.tagName === 'img' && typeof node.properties?.src === 'string' &&
    Boolean((presentation?.hiddenAssets ?? presentation?.assets)?.some(asset => figureAssetName(asset) === figureAssetName(node.properties!.src as string)))
  const hiddenText = (value: string): boolean => normalized.has(normalize(value))
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
