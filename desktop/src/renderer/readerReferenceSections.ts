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
  const text = (node: HeadingNode): string => node.value ?? (node.children ?? []).map(text).join('')
  for (const [index, block] of blocks.entries()) {
    if (block.role !== 'content') continue
    const tree = parser.parse(block.markdown) as HeadingNode
    for (const node of tree.children ?? []) if (node.type === 'heading') {
      const title = text(node).trim().replace(/^(?:(?:\d+(?:\.\d+)*|[IVX]+)[.、:]?\s+|第[^\s]+[章节章節]\s*)/u, '').replace(/[：:]$/u, '').trim()
      if (REFERENCE_TITLE.test(title)) depth = node.depth
      else if (depth !== undefined && (node.depth ?? 7) <= depth) depth = undefined
    }
    if (depth !== undefined) indexes.add(index)
  }
  return indexes
}
