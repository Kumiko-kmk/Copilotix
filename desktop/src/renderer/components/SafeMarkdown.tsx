import React from 'react'
import { Popover } from 'antd'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeTableMath from '../rehypeTableMath'
import type { Citation } from '@shared/ragSchemas'

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
}): React.JSX.Element {
  const markdown = props.citations ? props.markdown.replace(/\[(E\d+)\]/gu, (marker, id: string) => props.citations?.[id] ? `[${id}](#paper-evidence-${id})` : marker) : props.markdown
  const components = React.useMemo<Components>(() => ({
    img: ({ src, alt, width, height }) => props.citations ? <span>{alt}</span> : (
      <img
        src={resolveAsset(src, props.assetBaseUrl ?? '')}
        alt={alt ?? ''}
        width={width}
        height={height}
        loading="eager"
        decoding="async"
      />
    ),
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
          <Popover content={<CitationPreview citation={citation} />} mouseEnterDelay={0.25} placement="top">
            <button
              type="button"
              className="paper-chat-citation"
              aria-label={label === undefined ? id : `引用 ${label}`}
              onClick={() => props.onCitation?.(citation)}
            >
              {label ?? children}
            </button>
          </Popover>
        )
      }
      return <a href={href} target="_blank" rel="noreferrer">{children}</a>
    }
  }), [props.assetBaseUrl, props.citationLabels, props.citations, props.onCitation])

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[
        rehypeRaw,
        [rehypeSanitize, markdownSanitizeSchema],
        rehypeTableMath,
        [rehypeKatex, { trust: false, throwOnError: false, strict: 'ignore' }]
      ]}
      components={components}
    >
      {markdown}
    </ReactMarkdown>
  )
})

export default SafeMarkdown

function CitationPreview(props: { citation: Citation }): React.JSX.Element {
  const { excerpt, locator } = props.citation
  return (
    <div className="paper-chat-citation-preview">
      {locator.pageStart !== null ? <strong>第 {locator.pageStart + 1} 页</strong> : null}
      <p>{excerpt.length > 200 ? `${excerpt.slice(0, 200)}…` : excerpt}</p>
    </div>
  )
}

export function resolveAsset(src: string | undefined, base: string): string | undefined {
  if (!src || /^(https?:|data:|blob:|copilotix-asset:)/i.test(src)) return src
  return new URL(src.replace(/^\.\//, ''), base).toString()
}
