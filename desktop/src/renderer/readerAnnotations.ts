import { resolveReaderAnnotation } from '@shared/readerAnnotations'
import type {
  HighlightColor,
  ReaderAnnotation,
  ReaderChatSelectionFragment
} from '@shared/types'

export interface ReaderTextSelection {
  text: string
  fragments: ReaderChatSelectionFragment[]
  rect: { top: number; right: number; bottom: number; left: number; width: number; height: number }
}

export type HighlightBucket = `copilotix-highlight-${HighlightColor}` | 'copilotix-underline'
export type HighlightRanges = Map<HighlightBucket, Range[]>

const highlightOwners = new Map<string, HighlightRanges>()

export function captureReaderTextSelection(article: HTMLElement): ReaderTextSelection | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) return null
  const fragments: ReaderChatSelectionFragment[] = []
  const blocks = Array.from(article.querySelectorAll<HTMLElement>('[data-annotation-block-key]'))
  for (const block of blocks) {
    if (!range.intersectsNode(block)) continue
    const text = textContent(block)
    const startOffset = block.contains(range.startContainer)
      ? boundaryOffset(block, range.startContainer, range.startOffset)
      : 0
    const endOffset = block.contains(range.endContainer)
      ? boundaryOffset(block, range.endContainer, range.endOffset)
      : text.length
    if (endOffset <= startOffset) continue
    const quote = text.slice(startOffset, endOffset)
    if (!quote.trim()) continue
    fragments.push({
      blockKey: block.dataset.annotationBlockKey!,
      startOffset,
      endOffset,
      quote,
      mappingIds: block.dataset.mappingIds?.split(/\s+/).filter(Boolean) ?? [],
      ...(block.dataset.pageIndex ? { pageIndex: Number(block.dataset.pageIndex) } : {})
    })
  }
  if (fragments.length === 0) return null
  const rect = range.getBoundingClientRect()
  return {
    text: fragments.map((fragment) => fragment.quote).join('\n'),
    fragments,
    rect: {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height
    }
  }
}

export function collectAnnotationBlockTexts(article: HTMLElement): Map<string, string> {
  return new Map(
    Array.from(article.querySelectorAll<HTMLElement>('[data-annotation-block-key]'))
      .map((block) => [block.dataset.annotationBlockKey!, textContent(block)])
  )
}

export function buildReaderHighlightRanges(article: HTMLElement, annotations: ReaderAnnotation[]): HighlightRanges {
  const result: HighlightRanges = new Map()
  const blocks = new Map(
    Array.from(article.querySelectorAll<HTMLElement>('[data-annotation-block-key]'))
      .map((block) => [block.dataset.annotationBlockKey!, block])
  )
  for (const annotation of annotations) {
    const block = blocks.get(annotation.blockKey)
    if (!block) continue
    const resolved = resolveReaderAnnotation(textContent(block), annotation)
    if (!resolved) continue
    const range = rangeFromOffsets(block, resolved.startOffset, resolved.endOffset)
    if (!range) continue
    const bucket: HighlightBucket = annotation.kind === 'underline'
      ? 'copilotix-underline'
      : `copilotix-highlight-${annotation.color ?? 'yellow'}`
    const ranges = result.get(bucket) ?? []
    ranges.push(range)
    result.set(bucket, ranges)
  }
  return result
}

export function registerReaderHighlightRanges(owner: string, ranges: HighlightRanges): () => void {
  highlightOwners.set(owner, ranges)
  rebuildHighlightRegistry()
  return () => {
    highlightOwners.delete(owner)
    rebuildHighlightRegistry()
  }
}

export function clearBrowserTextSelection(): void {
  window.getSelection()?.removeAllRanges()
}

function rebuildHighlightRegistry(): void {
  const css = globalThis.CSS as typeof CSS & {
    highlights?: { set(name: string, value: unknown): void; delete(name: string): boolean }
  }
  const HighlightConstructor = (globalThis as typeof globalThis & {
    Highlight?: new (...ranges: Range[]) => unknown
  }).Highlight
  if (!css?.highlights || !HighlightConstructor) return
  const buckets = new Map<HighlightBucket, Range[]>()
  for (const ownerRanges of highlightOwners.values()) {
    for (const [bucket, ranges] of ownerRanges) {
      const current = buckets.get(bucket) ?? []
      current.push(...ranges)
      buckets.set(bucket, current)
    }
  }
  const names: HighlightBucket[] = [
    'copilotix-highlight-yellow',
    'copilotix-highlight-green',
    'copilotix-highlight-blue',
    'copilotix-highlight-pink',
    'copilotix-highlight-purple',
    'copilotix-underline'
  ]
  for (const name of names) {
    const ranges = buckets.get(name) ?? []
    if (ranges.length > 0) css.highlights.set(name, new HighlightConstructor(...ranges))
    else css.highlights.delete(name)
  }
}

function boundaryOffset(block: HTMLElement, container: Node, offset: number): number {
  const prefix = document.createRange()
  prefix.selectNodeContents(block)
  try {
    prefix.setEnd(container, offset)
    return prefix.toString().length
  } catch {
    return 0
  }
}

function textContent(block: HTMLElement): string {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let value = ''
  let node = walker.nextNode()
  while (node) {
    if (!(node.parentElement?.closest('[data-reader-annotation-ignore]'))) value += node.nodeValue ?? ''
    node = walker.nextNode()
  }
  return value
}

function rangeFromOffsets(block: HTMLElement, startOffset: number, endOffset: number): Range | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let node = walker.nextNode()
  while (node) {
    if (!node.parentElement?.closest('[data-reader-annotation-ignore]')) nodes.push(node as Text)
    node = walker.nextNode()
  }
  const start = locateOffset(nodes, startOffset)
  const end = locateOffset(nodes, endOffset)
  if (!start || !end) return null
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  return range
}

function locateOffset(nodes: Text[], target: number): { node: Text; offset: number } | null {
  let consumed = 0
  for (const node of nodes) {
    const length = node.data.length
    if (target <= consumed + length) return { node, offset: target - consumed }
    consumed += length
  }
  const last = nodes.at(-1)
  return last && target === consumed ? { node: last, offset: last.data.length } : null
}
