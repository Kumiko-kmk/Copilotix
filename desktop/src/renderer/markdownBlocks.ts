import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkStringify from 'remark-stringify'

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkStringify, { bullet: '-', fences: true, listItemIndent: 'one' })

export function splitMarkdownBlocks(markdown: string): string[] {
  const root = processor.parse(markdown) as any
  return (root.children ?? []).map((node: any) =>
    String(processor.stringify({ type: 'root', children: [node] } as any)).trimEnd()
  )
}
