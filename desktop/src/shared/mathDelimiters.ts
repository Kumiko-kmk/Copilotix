export interface MarkdownTextSegment {
  kind: 'text'
  value: string
}

export interface MarkdownMathSegment {
  kind: 'math'
  value: string
  content: string
  display: boolean
}

export type MarkdownSegment = MarkdownTextSegment | MarkdownMathSegment

/**
 * Split the math delimiter forms emitted by MinerU without guessing at bare
 * LaTeX commands. Keeping the delimiters in `value` lets translation callers
 * preserve source text byte-for-byte while renderers use `content`.
 */
export function splitMarkdownMath(value: string): MarkdownSegment[] {
  const parts: MarkdownSegment[] = []
  const pattern = /(\$\$[\s\S]*?\$\$|\$(?!\$|\s)(?:\\.|[^$\n])*?(?<!\s)\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) parts.push({ kind: 'text', value: value.slice(cursor, match.index) })
    const math = match[0]
    const display = math.startsWith('$$') || math.startsWith('\\[')
    const delimiterLength = display ? 2 : math.startsWith('$') ? 1 : 2
    parts.push({
      kind: 'math',
      value: math,
      content: math.slice(delimiterLength, -delimiterLength),
      display
    })
    cursor = match.index + math.length
  }
  if (cursor < value.length) parts.push({ kind: 'text', value: value.slice(cursor) })
  if (parts.length === 0) parts.push({ kind: 'text', value })
  return parts
}
