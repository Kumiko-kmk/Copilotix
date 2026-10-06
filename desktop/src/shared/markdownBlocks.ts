import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkStringify from 'remark-stringify'
import type { BlockMapping } from './types'
import { resolveMarkdownReferences } from './standardMarkdown'

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkStringify, { bullet: '-', fences: true, listItemIndent: 'one' })

/**
 * The RAG indexer uses the exact same remark pipeline as block alignment.  It
 * is intentionally exported as a small AST boundary instead of duplicating a
 * Markdown parser in the Utility process.
 */
export function parseMarkdownAst(markdown: string): any {
  return processor.parse(markdown)
}

export function stringifyMarkdownAst(node: any): string {
  return String(processor.stringify({ type: 'root', children: [node] } as any)).trimEnd()
}

export interface AlignedMarkdownBlock {
  markdown: string
  mappingIds: string[]
}

interface ParsedMarkdownBlock {
  markdown: string
  text: string
  containsMedia: boolean
  containsTable: boolean
  mediaSources: string[]
}

interface SourceInterval {
  mapping: BlockMapping
  start: number
  end: number
}

const MIN_SUBSTRING_TARGET_LENGTH = 16
export const MARKDOWN_MAPPING_ALGORITHM_VERSION = 1

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
  const intervalByMappingId = new Map<string, SourceInterval>()
  let sourceStream = ''
  for (const { mapping, text } of orderedSources) {
    if (!text) continue
    const start = sourceStream.length
    sourceStream += text
    const interval = { mapping, start, end: sourceStream.length }
    intervals.push(interval)
    intervalByMappingId.set(mapping.id, interval)
  }

  let sourceCursor = 0
  let mappingOrderCursor = orderedMappings[0]?.order ?? 0
  const usedMappingIds = new Set<string>()
  const targets = blocks.map((block) => canonicalText(block.text))
  const nextTargets = nextSignificantTargets(targets)
  return blocks.map((block, blockIndex) => {
    const target = targets[blockIndex] ?? ''
    let mappingIds: string[] = []
    if (target) {
      const exact = orderedSources.find(({ mapping, text }) =>
        mapping.order >= mappingOrderCursor &&
        !usedMappingIds.has(mapping.id) &&
        text === target
      )
      if (target.length < MIN_SUBSTRING_TARGET_LENGTH) {
        if (exact) mappingIds = [exact.mapping.id]
      } else {
        const range = locateTarget(sourceStream, target, sourceCursor, nextTargets[blockIndex])
        if (range) {
          const [start, end] = range
          mappingIds = unique(intervals
            .filter((interval) =>
              interval.mapping.order >= mappingOrderCursor &&
              !usedMappingIds.has(interval.mapping.id) &&
              interval.end > start &&
              interval.start < end
            )
            .map((interval) => interval.mapping.id))
          if (mappingIds.length > 0) sourceCursor = end
        }
        if (mappingIds.length === 0 && exact) mappingIds = [exact.mapping.id]
        if (mappingIds.length === 0) {
          const fallback = orderedSources.find(({ mapping, text }) =>
            mapping.order >= mappingOrderCursor &&
            !usedMappingIds.has(mapping.id) &&
            text.length >= MIN_SUBSTRING_TARGET_LENGTH &&
            (text.startsWith(target) || target.startsWith(text))
          )
          if (fallback) mappingIds = [fallback.mapping.id]
        }
      }
      const lastInterval = mappingIds
        .map((id) => intervalByMappingId.get(id))
        .filter((interval): interval is SourceInterval => Boolean(interval))
        .sort((left, right) => right.end - left.end)[0]
      if (lastInterval) sourceCursor = Math.max(sourceCursor, lastInterval.end)
    }

    if (mappingIds.length === 0 && block.containsTable) {
      const table = orderedMappings.find((mapping) => mapping.type === 'table' &&
        mapping.order >= mappingOrderCursor && !usedMappingIds.has(mapping.id))
      if (table) mappingIds = [table.id]
    }
    if (mappingIds.length === 0 && block.containsMedia) {
      const media = orderedMappings.find((mapping) =>
        mapping.order >= mappingOrderCursor &&
        !usedMappingIds.has(mapping.id) &&
        mapping.sourceAsset &&
        block.mediaSources.some((source) => assetName(source) === assetName(mapping.sourceAsset!))
      ) ?? orderedMappings.find((mapping) =>
        mapping.order >= mappingOrderCursor &&
        !usedMappingIds.has(mapping.id) &&
        isMediaType(mapping.type)
      )
      if (media) mappingIds = [media.id]
    }
    if (mappingIds.length > 0) {
      mappingIds = mappingIds.filter((id) => !usedMappingIds.has(id))
      const orders = mappingIds
        .map((id) => orderById.get(id))
        .filter((order): order is number => typeof order === 'number')
      if (orders.length > 0) {
        mappingOrderCursor = Math.max(...orders) + 1
        for (const id of mappingIds) usedMappingIds.add(id)
      }
    }
    return { markdown: block.markdown, mappingIds }
  })
}

function nextSignificantTargets(targets: string[]): Array<string | undefined> {
  const nextTargets = new Array<string | undefined>(targets.length)
  let nextTarget: string | undefined
  for (let index = targets.length - 1; index >= 0; index -= 1) {
    nextTargets[index] = nextTarget
    const target = targets[index]
    if (target && target.length >= 16) nextTarget = target
  }
  return nextTargets
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
  resolveMarkdownReferences(root)
  return (root.children ?? []).map((node: any) => ({
    markdown: String(processor.stringify({ type: 'root', children: [node] } as any)).trimEnd(),
    text: extractVisibleText(node),
    containsMedia: containsNodeType(node, new Set(['image', 'imageReference'])),
    containsTable: containsNodeType(node, new Set(['table'])),
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
