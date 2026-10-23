import { renderToString } from 'katex'
import { parseFragment } from 'parse5'
import { parseMarkdownAst } from '@shared/markdownBlocks'
import { splitMarkdownMath } from '@shared/mathDelimiters'

interface MarkdownNode { type: string; value?: string; children?: MarkdownNode[] }
interface HtmlNode { nodeName: string; tagName?: string; value?: string; childNodes?: HtmlNode[] }
const protectedTags = new Set(['code', 'pre', 'math', 'annotation'])
const removedTags = new Set(['script', 'style', 'iframe', 'object', 'embed'])

/**
 * A selection uses rendered text offsets; a chunk uses raw Markdown offsets.
 * Validate against a projection derived exclusively from the trusted chunk,
 * including the same KaTeX HTML+MathML text as the reader. No browser DOM,
 * filesystem or user-supplied rendering is involved, and locator offsets stay
 * in the original UTF-16 source coordinate system.
 */
export function paperSelectionText(markdown: string): string {
  const walk = (node: MarkdownNode): string => {
    if (node.type === 'inlineMath' || node.type === 'math') return mathText(node.value ?? '', node.type === 'math')
    if (node.type === 'html') return htmlText(node.value ?? '', true)
    if (['text', 'inlineCode', 'code'].includes(node.type)) return node.value ?? ''
    return node.children?.map(walk).join('') ?? ''
  }
  return walk(parseMarkdownAst(markdown) as MarkdownNode)
}

function mathText(content: string, displayMode: boolean): string {
  return htmlText(renderToString(content, { displayMode, trust: false, throwOnError: false, strict: 'ignore', maxExpand: 1000 }), false)
}

function htmlText(html: string, parseTableMath: boolean): string {
  const walk = (node: HtmlNode, cell = false, protectedAncestor = false): string => {
    const tag = node.tagName ?? ''
    if (removedTags.has(tag)) return ''
    const inCell = cell || tag === 'td' || tag === 'th'
    const protectedHere = protectedAncestor || protectedTags.has(tag)
    if (node.nodeName === '#text') {
      const value = node.value ?? ''
      return parseTableMath && inCell && !protectedHere
        ? splitMarkdownMath(value).map((s) => s.kind === 'text' ? s.value : mathText(s.content, s.display)).join('')
        : value
    }
    return node.childNodes?.map((child) => walk(child, inCell, protectedHere)).join('') ?? ''
  }
  return walk(parseFragment(html) as HtmlNode)
}
