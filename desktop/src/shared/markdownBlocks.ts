import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkStringify from 'remark-stringify'
import type { BlockMapping } from './types'

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkStringify, { bullet: '-', fences: true, listItemIndent: 'one' })

export interface AlignedMarkdownBlock {
  markdown: string
  mappingIds: string[]
}

interface ParsedMarkdownBlock {
  markdown: string
  text: string
  containsMedia: boolean
  mediaSources: string[]
}

interface SourceInterval {
  mapping: BlockMapping
  start: number
  end: number
}

export function splitMarkdownBlocks(markdown: string): string[] {
  return parseMarkdownBlocks(markdown).map((block) => block.markdown)
}

export function alignMarkdownBlocks(markdown: string, mappings: BlockMapping[]): AlignedMarkdownBlock[] {
  const blocks = parseMarkdownBlocks(markdown)
  const orderedMappings = [...mappings]
    .filter((mapping) => !mapping.boxes.every((box) => box.isDiscarded))
    .sort((left, right) => left.order - right.order)
  const orderedSources = orderedMappings.map((mapping) => ({ mapping, text: canonicalText(mapping.sourceText) }))
  const orderById = new Map(orderedMappings.map((mapping) => [mapping.id, mapping.order]))
  const intervals: SourceInterval[] = []
  let sourceStream = ''
  for (const { mapping, text } of orderedSources) {
    if (!text) continue
    const start = sourceStream.length
    sourceStream += text
    intervals.push({ mapping, start, end: sourceStream.length })
  }

  let sourceCursor = 0
  let mappingOrderCursor = 0
  const targets = blocks.map((block) => canonicalText(block.text))
  return blocks.map((block, blockIndex) => {
    const target = targets[blockIndex] ?? ''
    let mappingIds: string[] = []
    if (target) {
      const directIds = orderedSources
        .filter(({ text }) => {
          return text.length >= 24 && (target.includes(text) || text.includes(target))
        })
        .map(({ mapping }) => mapping.id)
      const nextTarget = targets.slice(blockIndex + 1).find((value) => value.length >= 16)
      const range = locateTarget(sourceStream, target, sourceCursor, nextTarget)
      if (range) {
        const [start, end] = range
        mappingIds = unique(intervals
          .filter((interval) => interval.end > start && interval.start < end)
          .map((interval) => interval.mapping.id))
        sourceCursor = end
      }
      mappingIds = unique([...mappingIds, ...directIds])
      if (mappingIds.length === 0) {
        const fallback = orderedSources.find(({ mapping, text }) => {
          if (mapping.order < mappingOrderCursor) return false
          return text.length >= 16 && (text.startsWith(target) || target.startsWith(text))
        })
        if (fallback) mappingIds = [fallback.mapping.id]
      }
    }

    if (mappingIds.length === 0 && block.containsMedia) {
      const media = orderedMappings.find((mapping) =>
        mapping.sourceAsset && block.mediaSources.some((source) => assetName(source) === assetName(mapping.sourceAsset!))
      ) ?? orderedMappings.find((mapping) => mapping.order >= mappingOrderCursor && isMediaType(mapping.type))
      if (media) mappingIds = [media.id]
    }
    if (mappingIds.length > 0) {
      const orders = mappingIds
        .map((id) => orderById.get(id))
        .filter((order): order is number => typeof order === 'number')
      if (orders.length > 0) mappingOrderCursor = Math.max(mappingOrderCursor, ...orders)
    }
    return { markdown: block.markdown, mappingIds }
  })
}

function locateTarget(source: string, target: string, cursor: number, nextTarget?: string): [number, number] | null {
  const exactStart = source.indexOf(target, cursor)
  if (exactStart >= 0) return [exactStart, exactStart + target.length]
  if (target.length < 96) return null

  const startMatch = findAnchor(source, target, cursor, false)
  if (!startMatch) return null
  const { index: start, length: anchorLength } = startMatch
  const endMatch = findAnchor(source, target, start + anchorLength, true)
  if (endMatch) {
    const end = endMatch.index + endMatch.length
    if (end - start <= target.length * 1.5 + 512) return [start, end]
  }
  if (nextTarget) {
    const nextMatch = findAnchor(source, nextTarget, start + anchorLength, false)
    if (nextMatch && nextMatch.index > start) return [start, nextMatch.index]
  }
  return nextTarget ? null : [start, source.length]
}

function findAnchor(source: string, target: string, cursor: number, fromEnd: boolean): { index: number; length: number } | null {
  const maximum = Math.min(64, Math.floor(target.length / 4))
  const lengths = uniqueNumbers([maximum, 48, 32, 24, 16]).filter((length) => length <= maximum && length >= 16)
  for (const length of lengths) {
    const anchor = fromEnd ? target.slice(-length) : target.slice(0, length)
    const index = source.indexOf(anchor, cursor)
    if (index >= 0) return { index, length }
  }
  return null
}

function parseMarkdownBlocks(markdown: string): ParsedMarkdownBlock[] {
  const root = processor.parse(markdown) as any
  return (root.children ?? []).map((node: any) => ({
    markdown: String(processor.stringify({ type: 'root', children: [node] } as any)).trimEnd(),
    text: extractVisibleText(node),
    containsMedia: containsNodeType(node, new Set(['image', 'imageReference'])),
    mediaSources: extractMediaSources(node)
  }))
}

function extractMediaSources(node: any): string[] {
  if (!node || typeof node !== 'object') return []
  const own = node.type === 'image' && typeof node.url === 'string' ? [node.url] : []
  if (!Array.isArray(node.children)) return own
  return [...own, ...node.children.flatMap(extractMediaSources)]
}

function extractVisibleText(node: any): string {
  if (!node || typeof node !== 'object') return ''
  if (typeof node.value === 'string' && ['text', 'inlineCode', 'code', 'math', 'inlineMath', 'html'].includes(node.type)) {
    return node.type === 'html' ? node.value.replace(/<[^>]*>/g, ' ') : node.value
  }
  if (node.type === 'image' || node.type === 'imageReference') return typeof node.alt === 'string' ? node.alt : ''
  if (!Array.isArray(node.children)) return ''
  return node.children.map(extractVisibleText).filter(Boolean).join(' ')
}

function containsNodeType(node: any, types: Set<string>): boolean {
  if (!node || typeof node !== 'object') return false
  if (types.has(node.type)) return true
  return Array.isArray(node.children) && node.children.some((child: any) => containsNodeType(child, types))
}

function canonicalText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos);/gi, (entity) => decodeEntity(entity.toLowerCase()))
    .replace(/<[^>]*>/g, ' ')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function decodeEntity(entity: string): string {
  if (entity === '&nbsp;') return ' '
  if (entity === '&amp;') return '&'
  if (entity === '&lt;') return '<'
  if (entity === '&gt;') return '>'
  if (entity === '&quot;') return '"'
  if (entity === '&apos;') return "'"
  return entity
}

function isMediaType(type: string): boolean {
  return ['image', 'chart', 'table'].includes(type)
}

function assetName(value: string): string {
  return value.replace(/\\/g, '/').split('/').pop()?.toLocaleLowerCase('en-US') ?? value.toLocaleLowerCase('en-US')
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)]
}
