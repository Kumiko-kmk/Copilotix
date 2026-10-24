import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { ReaderBlock } from '@shared/readerDocument'

type HeadingNode = { type: string; depth?: number; value?: string; children?: HeadingNode[] }
const parser = unified().use(remarkParse)
const REFERENCE_TITLE = /^(?:references?|bibliography|literature\s+cited|works\s+cited|参考文献|參考文獻|参考资料|參考資料)$/iu

/** Follow heading scope, so an appendix after References uses normal typography. */
export function readerReferenceSections(blocks: readonly ReaderBlock[]): Set<number> {
  const indexes = new Set<number>()
  let depth: number | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.role !== 'content') continue
    for (const heading of blockHeadings(block.markdown)) {
      if (heading.reference) depth = heading.depth
      else if (depth !== undefined && (heading.depth ?? 7) <= depth) depth = undefined
    }
    if (depth !== undefined) indexes.add(index)
  }
  return indexes
}

/** Headings of one block's Markdown. Cached by text: an edit re-parses only the edited block. */
const headingCache = new Map<string, Array<{ depth: number | undefined; reference: boolean }>>()
function blockHeadings(markdown: string): Array<{ depth: number | undefined; reference: boolean }> {
  let headings = headingCache.get(markdown)
  if (headings) return headings
  const text = (node: HeadingNode): string => node.value ?? (node.children ?? []).map(text).join('')
  const tree = parser.parse(markdown) as HeadingNode
  headings = (tree.children ?? []).filter(node => node.type === 'heading').map(node => {
    const title = text(node).trim().replace(/^(?:(?:\d+(?:\.\d+)*|[IVX]+)[.、:]?\s+|第[^\s]+[章节章節]\s*)/u, '').replace(/[：:]$/u, '').trim()
    return { depth: node.depth, reference: REFERENCE_TITLE.test(title) }
  })
  if (headingCache.size >= 8_000) headingCache.delete(headingCache.keys().next().value!)
  headingCache.set(markdown, headings)
  return headings
}
