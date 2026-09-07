import type { ReaderBlock } from '@shared/readerDocument'
import type { BlockBox, BlockMapping } from '@shared/types'

export interface ReaderFigureGroup {
  id: string
  pageIndex: number
  cropBox: [number, number, number, number]
  pageSize: [number, number]
  mappingIds: string[]
  assetSources: string[]
  fallbackLegendMarkdown: string
  ownerBlockIndex: number
  captionBlockIndex: number
  memberBlockIndexes: number[]
  captionMarkdown: string
  captionPrefixMarkdown: string
}

const ALLOWED_FIGURE_TYPES = new Set(['chart', 'chart_caption', 'chart_footnote'])
const MIN_VERTICAL_OVERLAP = 0.6
const SHARED_CAPTION_WIDTH_RATIO = 0.75
const CROP_PADDING_POINTS = 4

export function buildReaderFigureGroups(
  blocks: readonly ReaderBlock[],
  mappings: readonly BlockMapping[]
): ReaderFigureGroup[] {
  const ordered = [...mappings]
    .filter((mapping) => mapping.boxes.some((box) => !box.isDiscarded))
    .sort((left, right) => left.order - right.order)
  const groups: ReaderFigureGroup[] = []
  const consumed = new Set<string>()

  for (let start = 0; start < ordered.length; start += 1) {
    const first = ordered[start]
    const firstBox = primaryBox(first)
    if (!first || !firstBox || normalizeType(first.type) !== 'chart' || consumed.has(first.id)) continue
    const run: BlockMapping[] = []
    for (let index = start; index < ordered.length; index += 1) {
      const candidate = ordered[index]
      const box = candidate ? primaryBox(candidate) : undefined
      if (!candidate || !box || box.pageIndex !== firstBox.pageIndex || !ALLOWED_FIGURE_TYPES.has(normalizeType(candidate.type))) break
      run.push(candidate)
      if (run.length >= 2 && isSharedCaption(candidate, run)) break
    }
    const charts = run.filter((mapping) => normalizeType(mapping.type) === 'chart' && primaryBox(mapping))
    if (charts.length < 2 || !chartsShareOneRow(charts)) continue

    const chartUnion = unionBoxes(charts.map((mapping) => primaryBox(mapping)!))
    const sharedCaption = run.find((mapping) => {
      const box = primaryBox(mapping)
      return normalizeType(mapping.type) === 'chart_caption' && box !== undefined &&
        box.bbox[1] >= chartUnion[3] && width(box.bbox) >= width(chartUnion) * SHARED_CAPTION_WIDTH_RATIO
    })
    const footnotes = run.filter((mapping) => normalizeType(mapping.type) === 'chart_footnote')
    if (!sharedCaption || footnotes.length === 0) continue

    const visualMappings = run.filter((mapping) => mapping !== sharedCaption)
    const visualBoxes = visualMappings.map(primaryBox).filter((box): box is BlockBox => Boolean(box))
    const pageSize = firstBox.pageSize
    const cropBox = paddedBox(unionBoxes(visualBoxes), pageSize, CROP_PADDING_POINTS)
    const mappingIds = run.map((mapping) => mapping.id)
    const assetSources = charts.map((mapping) => mapping.sourceAsset).filter((asset): asset is string => Boolean(asset))
    const memberBlockIndexes = blocks.flatMap((block, index) =>
      block.mappingIds.some((id) => mappingIds.includes(id)) || assetSources.some((asset) => containsAsset(block.markdown, asset))
        ? [index]
        : []
    )
    if (memberBlockIndexes.length < 2 || assetSources.length < 2) continue
    const captionBlockIndex = memberBlockIndexes.find((index) => blocks[index]?.mappingIds.includes(sharedCaption.id))
    if (captionBlockIndex === undefined) continue
    const split = splitFigureCaption(blocks[captionBlockIndex]?.markdown ?? '')
    if (!split) continue

    const group: ReaderFigureGroup = {
      id: `reader-figure-${firstBox.pageIndex}-${charts.map((chart) => chart.order).join('-')}`,
      pageIndex: firstBox.pageIndex,
      cropBox,
      pageSize,
      mappingIds,
      assetSources,
      fallbackLegendMarkdown: split.legendMarkdown || footnotes.map((mapping) => mapping.sourceText).join(' '),
      ownerBlockIndex: Math.min(...memberBlockIndexes),
      captionBlockIndex,
      memberBlockIndexes,
      captionMarkdown: split.captionMarkdown,
      captionPrefixMarkdown: split.prefixMarkdown
    }
    groups.push(group)
    mappingIds.forEach((id) => consumed.add(id))
  }
  return groups
}

function splitFigureCaption(markdown: string): {
  prefixMarkdown: string
  captionMarkdown: string
  legendMarkdown: string
} | null {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const nonEmpty = lines.map((line, index) => ({ line: line.trim(), index })).filter(({ line }) => line)
  if (nonEmpty.length < 3) return null
  const caption = nonEmpty.at(-1)!
  if (/^!\[.*\]\([^)]*\)\s*[\\ ]*$/u.test(caption.line)) return null
  const legend = [...nonEmpty].reverse().slice(1).find(({ line }) => !/^!\[/u.test(line))
  return {
    prefixMarkdown: lines.slice(0, caption.index).join('\n').trimEnd(),
    captionMarkdown: caption.line.replace(/[\\ ]+$/u, ''),
    legendMarkdown: (legend?.line ?? '').replace(/[\\ ]+$/u, '')
  }
}

function isSharedCaption(mapping: BlockMapping, run: readonly BlockMapping[]): boolean {
  if (normalizeType(mapping.type) !== 'chart_caption') return false
  const charts = run.filter((candidate) => normalizeType(candidate.type) === 'chart' && primaryBox(candidate))
  if (charts.length < 2) return false
  const box = primaryBox(mapping)
  const chartUnion = unionBoxes(charts.map((chart) => primaryBox(chart)!))
  return Boolean(box && box.bbox[1] >= chartUnion[3] && width(box.bbox) >= width(chartUnion) * SHARED_CAPTION_WIDTH_RATIO)
}

function chartsShareOneRow(charts: readonly BlockMapping[]): boolean {
  const boxes = charts.map((chart) => primaryBox(chart)!).sort((left, right) => left.bbox[0] - right.bbox[0])
  for (let index = 1; index < boxes.length; index += 1) {
    const left = boxes[index - 1]!
    const right = boxes[index]!
    const overlap = Math.max(0, Math.min(left.bbox[3], right.bbox[3]) - Math.max(left.bbox[1], right.bbox[1]))
    const minimumHeight = Math.min(height(left.bbox), height(right.bbox))
    if (minimumHeight <= 0 || overlap / minimumHeight < MIN_VERTICAL_OVERLAP || left.bbox[2] > right.bbox[0]) return false
  }
  return true
}

function primaryBox(mapping: BlockMapping | undefined): BlockBox | undefined {
  return mapping?.boxes.find((box) => !box.isDiscarded)
}

function unionBoxes(boxes: readonly BlockBox[]): [number, number, number, number]
function unionBoxes(boxes: readonly [number, number, number, number][]): [number, number, number, number]
function unionBoxes(boxes: readonly (BlockBox | [number, number, number, number])[]): [number, number, number, number] {
  const values = boxes.map((box) => Array.isArray(box) ? box : box.bbox)
  return [
    Math.min(...values.map((box) => box[0])),
    Math.min(...values.map((box) => box[1])),
    Math.max(...values.map((box) => box[2])),
    Math.max(...values.map((box) => box[3]))
  ]
}

function paddedBox(
  box: [number, number, number, number],
  pageSize: [number, number],
  padding: number
): [number, number, number, number] {
  return [
    Math.max(0, box[0] - padding),
    Math.max(0, box[1] - padding),
    Math.min(pageSize[0], box[2] + padding),
    Math.min(pageSize[1], box[3] + padding)
  ]
}

function containsAsset(markdown: string, asset: string): boolean {
  const name = asset.replace(/\\/g, '/').split('/').pop()?.toLocaleLowerCase('en-US') ?? ''
  return Boolean(name && markdown.replace(/\\/g, '/').toLocaleLowerCase('en-US').includes(name))
}

function normalizeType(value: string): string {
  return value.trim().toLocaleLowerCase('en-US').replace(/[\s-]+/g, '_')
}

function width(box: readonly [number, number, number, number]): number {
  return Math.max(0, box[2] - box[0])
}

function height(box: readonly [number, number, number, number]): number {
  return Math.max(0, box[3] - box[1])
}
