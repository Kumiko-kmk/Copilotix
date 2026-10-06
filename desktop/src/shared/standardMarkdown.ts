import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkStringify from 'remark-stringify'
import { splitMarkdownMath } from './mathDelimiters'

/** Public artifacts use CommonMark + GFM tables and the explicit $ / $$ math extension. */
export const MARKDOWN_FORMAT_VERSION = 'commonmark-gfm-math-v1'

interface Node {
  type: string
  value?: string
  children?: Node[]
  url?: string
  identifier?: string
  referenceType?: string
  alt?: string
  title?: string | null
  depth?: number
  ordered?: boolean
  start?: number
  spread?: boolean
  lang?: string | null
  align?: Array<null>
  position?: { start: { offset?: number }; end: { offset?: number } }
}
type Html = DefaultTreeAdapterMap['node']
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
  .use(remarkStringify, { bullet: '-', fences: true, listItemIndent: 'one', resourceLink: true })
const text = (value: string): Node => ({ type: 'text', value })
const paragraph = (children: Node[]): Node => ({ type: 'paragraph', children })
const children = (node: Html): Html[] => 'childNodes' in node ? node.childNodes : []
const tag = (node: Html): string => 'tagName' in node ? node.tagName : ''
const attribute = (node: Html, name: string): string | undefined => 'attrs' in node
  ? node.attrs.find((attr) => attr.name === name)?.value : undefined
const plain = (node: Html): string => 'value' in node ? node.value : children(node).map(plain).join('')

export interface MarkdownNormalization {
  markdown: string
  controlsReplaced: number
  tablesConverted: number
}

/** Code is opaque. Normalize alternate TeX delimiters before Markdown consumes their escapes. */
function canonicalDelimiters(source: string): string {
  const root = processor.parse(source) as unknown as Node
  const protectedRanges: Array<[number, number]> = []
  walk(root, (node) => {
    if (['code', 'inlineCode', 'html'].includes(node.type) && node.position) {
      protectedRanges.push([node.position.start.offset ?? 0, node.position.end.offset ?? 0])
    }
  })
  return source.replace(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/gu, (match, inline: string | undefined, display: string | undefined, offset: number) => {
    if (protectedRanges.some(([start, end]) => offset >= start && offset < end)) return match
    return display === undefined ? `$${inline}$` : `\n\n$$\n${display.trim()}\n$$\n\n`
  })
}

function mathText(value: string): Node[] {
  return splitMarkdownMath(value).map((part) => part.kind === 'text' ? text(part.value) : {
    type: 'inlineMath', value: part.content.trim()
  })
}

function htmlInline(node: Html, placeholders: Node[] = []): Node[] {
  if (node.nodeName === '#comment') return []
  if ('value' in node) return mathText(node.value.replace(/\s+/gu, ' '))
  const name = tag(node)
  if (name === 'copilotix-md') return [placeholders[Number(attribute(node, 'data-index'))]!].filter(Boolean)
  if (name === 'script' || name === 'style') return []
  if (name === 'br') return [text(' ')]
  if (name === 'img') return [{ type: 'image', url: attribute(node, 'src') ?? '', alt: attribute(node, 'alt') ?? '', title: attribute(node, 'title') ?? null }]
  if (name === 'code' || name === 'pre') return [{ type: 'inlineCode', value: plain(node) }]
  if (name === 'math') {
    const annotation = findHtml(node, 'annotation').find((item) => attribute(item, 'encoding') === 'application/x-tex')
    return annotation ? [{ type: 'inlineMath', value: plain(annotation) }] : [text(plain(node))]
  }
  const content = children(node).flatMap((child) => htmlInline(child, placeholders))
  if (name === 'sup' || name === 'sub') return content.every((child) => child.type === 'text') && /^[A-Za-z0-9+.,-]{1,12}$/u.test(content.map((child) => child.value).join(''))
    ? [{ type: 'inlineMath', value: `{}${name === 'sup' ? '^' : '_'}{${content.map((child) => child.value).join('')}}` }] : content
  if (['b', 'strong'].includes(name)) return [{ type: 'strong', children: content }]
  if (['i', 'em'].includes(name)) return [{ type: 'emphasis', children: content }]
  if (['s', 'del', 'strike'].includes(name)) return [{ type: 'delete', children: content }]
  if (name === 'a' && attribute(node, 'href')) return [{ type: 'link', url: attribute(node, 'href'), title: attribute(node, 'title') ?? null, children: content }]
  return isBlockTag(name) && content.length ? [...content, text(' ')] : content
}

function findHtml(node: Html, name: string): Html[] {
  return [...(tag(node) === name ? [node] : []), ...children(node).flatMap((child) => findHtml(child, name))]
}

function htmlTable(table: Html, stats: MarkdownNormalization): Node[] {
  const rows: Html[] = []
  const collect = (node: Html): void => {
    if (node !== table && tag(node) === 'table') return
    if (tag(node) === 'tr') rows.push(node)
    else children(node).forEach(collect)
  }
  collect(table)
  const grid: Node[][] = []
  let width = 0
  for (let r = 0; r < rows.length; r += 1) {
    grid[r] ??= []
    let c = 0
    for (const cell of children(rows[r]!).filter((node) => ['th', 'td'].includes(tag(node)))) {
      while (grid[r]![c]) c += 1
      const rowSpan = Math.max(1, Number.parseInt(attribute(cell, 'rowspan') ?? '1', 10) || 1)
      const colSpan = Math.max(1, Number.parseInt(attribute(cell, 'colspan') ?? '1', 10) || 1)
      // Bound expansion; never silently truncate a malformed parser table.
      if (r + rowSpan > 4096 || c + colSpan > 256) throw new Error('表格合并范围超出支持上限，请核对解析结果')
      const content = htmlInline(cell)
      for (let rr = r; rr < r + rowSpan; rr += 1) {
        grid[rr] ??= []
        for (let cc = c; cc < c + colSpan; cc += 1) {
          grid[rr]![cc] = { type: 'tableCell', children: rr === r && cc === c
            ? structuredClone(content) : withoutImages(content) }
        }
      }
      c += colSpan
      width = Math.max(width, c)
    }
  }
  stats.tablesConverted += 1
  const captions = children(table).filter((node) => tag(node) === 'caption').map((node) => paragraph(htmlInline(node)))
  if (!width) return captions
  return [...captions, { type: 'table', align: Array<null>(width).fill(null), children: grid.map((row) => ({
    type: 'tableRow', children: Array.from({ length: width }, (_, c) => row[c] ?? { type: 'tableCell', children: [] })
  })) }]
}

function withoutImages(nodes: Node[]): Node[] {
  return nodes.filter((node) => node.type !== 'image').map((node) => ({ ...node,
    ...(node.children ? { children: withoutImages(node.children) } : {}) }))
}

function htmlBlock(node: Html, stats: MarkdownNormalization): Node[] {
  const name = tag(node)
  if (name === 'table') return htmlTable(node, stats)
  if (name === 'pre') return [{ type: 'code', lang: null, value: plain(node).replace(/\n$/u, '') }]
  if (/^h[1-6]$/u.test(name)) return [{ type: 'heading', depth: Number(name[1]), children: htmlInline(node) }]
  if (name === 'hr') return [{ type: 'thematicBreak' }]
  if (name === 'script' || name === 'style' || node.nodeName === '#comment') return []
  if ('value' in node && !node.value.trim()) return []
  if (name === 'blockquote') return [{ type: 'blockquote', children: htmlBlocks(children(node), stats) }]
  if (['ul', 'ol'].includes(name)) return [{ type: 'list', ordered: name === 'ol', start: Number(attribute(node, 'start') ?? 1), spread: false,
    children: children(node).filter((child) => tag(child) === 'li').map((child) => ({
      type: 'listItem', spread: false, children: htmlBlocks(children(child), stats)
    })) }]
  if (children(node).some((child) => isBlockTag(tag(child)))) return htmlBlocks(children(node), stats)
  const content = htmlInline(node)
  return content.length ? [paragraph(content)] : []
}

const isBlockTag = (name: string): boolean => /^(?:table|div|p|section|article|figure|figcaption|pre|ul|ol|blockquote|h[1-6]|hr)$/u.test(name)
function htmlBlocks(nodes: Html[], stats: MarkdownNormalization): Node[] {
  const result: Node[] = []
  let pending: Node[] = []
  const flush = (): void => { if (pending.length) result.push(paragraph(pending)); pending = [] }
  for (const node of nodes) {
    if (isBlockTag(tag(node))) { flush(); result.push(...htmlBlock(node, stats)) }
    else pending.push(...htmlInline(node))
  }
  flush()
  return result
}

function normalizeTree(node: Node, stats: MarkdownNormalization, parent = 'root'): Node[] {
  if (node.type === 'html') {
    const fragment = parseFragment(node.value ?? '')
    return ['root', 'listItem', 'blockquote'].includes(parent)
      ? htmlBlocks(fragment.childNodes, stats) : fragment.childNodes.flatMap((child) => htmlInline(child))
  }
  if (node.children) {
    // Inline HTML tags are separate Markdown nodes. Parse the complete sibling
    // run with opaque placeholders so <b>text</b> retains emphasis and links/math.
    if (['paragraph', 'heading', 'tableCell'].includes(node.type) && node.children.some((child) => child.type === 'html')) {
      const placeholders: Node[] = []
      const html = node.children.map((child) => {
        if (child.type === 'html') return child.value ?? ''
        placeholders.push(child)
        return `<copilotix-md data-index="${placeholders.length - 1}"></copilotix-md>`
      }).join('')
      node.children = parseFragment(html).childNodes.flatMap((child) => htmlInline(child, placeholders))
    }
    node.children = node.children.flatMap((child) => normalizeTree(child, stats, node.type))
  }
  // A literal pipe is a table delimiter even inside math. Equivalent TeX macros
  // avoid the GFM escape being consumed as part of the norm operator.
  if (parent === 'tableCell') tableMath(node)
  return [node]
}

function tableMath(node: Node): void {
  if (node.type === 'inlineMath' && node.value?.includes('|')) {
    node.value = node.value.replace(/\\\|/gu, '\\Vert ').replace(/\|/gu, '\\vert ')
  }
  node.children?.forEach(tableMath)
}

function trimInlineEdges(node: Node): void {
  if (['tableCell', 'paragraph', 'heading'].includes(node.type) && node.children) {
    while (node.children[0]?.type === 'text') {
      node.children[0].value = (node.children[0].value ?? '').trimStart()
      if (node.children[0].value) break
      node.children.shift()
    }
    while (node.children.at(-1)?.type === 'text') {
      const last = node.children.at(-1)!
      last.value = (last.value ?? '').trimEnd()
      if (last.value) break
      node.children.pop()
    }
  }
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node)
  node.children?.forEach((child) => walk(child, visit))
}

export function normalizeMarkdown(source: string, rewriteImage?: (url: string) => string): MarkdownNormalization {
  const stats: MarkdownNormalization = { markdown: '', controlsReplaced: 0, tablesConverted: 0 }
  const clean = source.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, () => { stats.controlsReplaced += 1; return '\uFFFD' })
  const root = normalizeTree(processor.parse(canonicalDelimiters(clean)) as unknown as Node, stats)[0]!
  walk(root, (node) => {
    trimInlineEdges(node)
    if (node.type === 'tableCell') tableMath(node)
  })
  resolveMarkdownReferences(root)
  if (rewriteImage) walk(root, (node) => { if (node.type === 'image') node.url = rewriteImage(node.url ?? '') })
  const serialized = String(processor.stringify(root as Parameters<typeof processor.stringify>[0]))
  // Reparse generated cells once: GFM recognizes bare URLs and trims cell
  // boundaries. Publishing that parsed form makes repeated normalization stable.
  stats.markdown = String(processor.stringify(processor.parse(serialized)))
  return stats
}

/** Keep block renderers/translators independent of document-wide definitions. */
export function resolveMarkdownReferences(tree: unknown): void {
  const root = tree as Node
  const definitions = new Map<string, Node>()
  walk(root, (node) => {
    const key = node.identifier?.toLowerCase()
    if (node.type === 'definition' && key && !definitions.has(key)) definitions.set(key, node)
  })
  walk(root, (node) => {
    if (!['imageReference', 'linkReference'].includes(node.type)) return
    const definition = definitions.get((node.identifier ?? '').toLowerCase())
    if (!definition?.url) return
    node.type = node.type === 'imageReference' ? 'image' : 'link'
    node.url = definition.url; node.title = definition.title
    delete node.identifier; delete node.referenceType
  })
}

export function isLocalMarkdownImage(url: string): boolean {
  return Boolean(url) && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(url)
}
