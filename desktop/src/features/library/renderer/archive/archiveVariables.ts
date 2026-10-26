interface Node {
  type: string; value?: string; children?: Node[]; data?: Record<string, unknown>
  position?: { start: { offset?: number }; end: { offset?: number } }
}

// A single-letter/Greek symbol with a subscript is the narrow legacy form we can
// render without reconstructing expressions. Code, links and explicit maths keep
// their original semantics; ordinary identifiers and paths are not mathematics.
const VARIABLE = /(?<![\p{L}\p{N}_/\\.:])(?:(√))?([A-Za-z\u03b1-\u03c9])_([A-Za-z0-9]+)(?![\p{L}\p{N}_/.])/gu
const PROTECTED = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'link', 'linkReference', 'html'])

export function remarkArchiveVariables(): (tree: Node, file: { value: unknown }) => void {
  return (tree, file) => visit(tree, String(file.value))
}

function visit(node: Node, source: string): void {
  if (PROTECTED.has(node.type) || !node.children) return
  node.children = node.children.flatMap(child => {
    if (child.type !== 'text' || !child.value) { visit(child, source); return [child] }
    const raw = source.slice(child.position?.start.offset ?? 0, child.position?.end.offset ?? source.length)
    const parts: Node[] = []
    let cursor = 0
    for (const match of child.value.matchAll(VARIABLE)) {
      if (raw.includes(`${match[2]}\\_${match[3]}`)) continue
      if (match.index > cursor) parts.push({ type: 'text', value: child.value.slice(cursor, match.index) })
      const subscript = match[3]!.length > 1 && /^[A-Za-z]+$/u.test(match[3]!) ? `\\mathrm{${match[3]}}` : match[3]!
      const symbol = `${match[2]}_{${subscript}}`
      const value = match[1] ? `\\sqrt{${symbol}}` : symbol
      parts.push({ type: 'inlineMath', value, data: {
        hName: 'code', hProperties: { className: ['language-math', 'math-inline'] },
        hChildren: [{ type: 'text', value }]
      } })
      cursor = match.index + match[0].length
    }
    if (!parts.length) return [child]
    if (cursor < child.value.length) parts.push({ type: 'text', value: child.value.slice(cursor) })
    return parts
  })
}
