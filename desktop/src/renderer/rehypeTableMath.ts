import { splitMarkdownMath } from '@shared/mathDelimiters'

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

const PROTECTED_TAGS = new Set(['code', 'pre', 'script', 'style', 'math', 'annotation'])

/** Parse math delimiters inside raw HTML table cells after rehype-raw. */
export default function rehypeTableMath(): (tree: HastNode) => void {
  return (tree) => transformChildren(tree, false, false)
}

function transformChildren(node: HastNode, insideCell: boolean, protectedAncestor: boolean): void {
  if (!Array.isArray(node.children)) return
  const tagName = node.tagName?.toLowerCase() ?? ''
  const inCell = insideCell || tagName === 'td' || tagName === 'th'
  const protectedHere = protectedAncestor || PROTECTED_TAGS.has(tagName) || hasClass(node, 'katex')

  const children: HastNode[] = []
  for (const child of node.children) {
    if (inCell && !protectedHere && child.type === 'text' && typeof child.value === 'string') {
      children.push(...mathNodes(child.value))
      continue
    }
    transformChildren(child, inCell, protectedHere)
    children.push(child)
  }
  node.children = children
}

function mathNodes(value: string): HastNode[] {
  const segments = splitMarkdownMath(value)
  if (!segments.some((segment) => segment.kind === 'math')) return [{ type: 'text', value }]
  return segments.map((segment): HastNode => segment.kind === 'text'
    ? { type: 'text', value: segment.value }
    : {
        type: 'element',
        tagName: 'code',
        properties: { className: [segment.display ? 'math-display' : 'math-inline'] },
        children: [{ type: 'text', value: segment.content }]
      })
}

function hasClass(node: HastNode, expected: string): boolean {
  const className = node.properties?.className
  const values = Array.isArray(className) ? className : typeof className === 'string' ? className.split(/\s+/u) : []
  return values.includes(expected)
}
