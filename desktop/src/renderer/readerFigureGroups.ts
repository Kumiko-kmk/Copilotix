import type { ReaderBlock } from '@shared/readerDocument'
import type { BlockBox, BlockMapping } from '@shared/types'

export interface ReaderFigureGeometry {
  id: string
  pageIndex: number
  cropBox: [number, number, number, number]
  pageSize: [number, number]
  mappingIds: string[]
  assetSources: string[]
  captionMappingId: string
  fallbackLegendText: string
}

export interface ReaderFigureGroup extends ReaderFigureGeometry {
  fallbackLegendMarkdown: string
  ownerBlockIndex: number
  captionBlockIndex: number
  memberBlockIndexes: number[]
  captionMarkdown: string
  captionPrefixMarkdown: string
}

const FIGURE_ASSET_TYPES = new Set(['chart', 'image'])
const SUPPORTING_TYPES = new Set(['chart_caption', 'chart_footnote', 'text'])
const MIN_VERTICAL_OVERLAP = 0.4
const SHARED_CAPTION_MIN_PAGE_WIDTH = 0.2
const MAX_FIGURE_CAPTION_GAP_RATIO = 0.22
const CROP_PADDING_POINTS = 4
const SUBFIGURE_LABEL = /^\s*[（(]\s*[a-zA-Z一二三四五六七八九十]+\s*[)）]\s*[.。]?\s*$/u
const FIGURE_CAPTION_PREFIX = /^\s*(?:fig(?:ure)?\.?|图)\s*[A-Z]?\d/iu

export function buildReaderFigureGeometries(mappings: readonly BlockMapping[]): ReaderFigureGeometry[] {
  const visible = mappings.filter((mapping) => primaryBox(mapping)).sort((left, right) => left.order - right.order)
  const pages = new Map<number, BlockMapping[]>()
  for (const mapping of visible) {
    const pageIndex = primaryBox(mapping)!.pageIndex
    const page = pages.get(pageIndex) ?? []
    page.push(mapping)
    pages.set(pageIndex, page)
  }

  const geometries: ReaderFigureGeometry[] = []
  const consumedAssets = new Set<string>()
  for (const [pageIndex, pageMappings] of pages) {
    const captions = pageMappings.filter(isSharedCaptionCandidate)
      .sort((left, right) => primaryBox(left)!.bbox[1] - primaryBox(right)!.bbox[1])
    let previousCaptionBottom = 0
    for (const caption of captions) {
      const captionBox = primaryBox(caption)!
      const maxGap = captionBox.pageSize[1] * MAX_FIGURE_CAPTION_GAP_RATIO
      const candidates = pageMappings.filter((mapping) => {
        const box = primaryBox(mapping)
        return box && FIGURE_ASSET_TYPES.has(normalizeType(mapping.type)) && mapping.sourceAsset &&
          !consumedAssets.has(mapping.id) && box.bbox[1] >= previousCaptionBottom &&
          mapping.order < caption.order && box.bbox[3] <= captionBox.bbox[1] + 2 &&
          captionBox.bbox[1] - box.bbox[3] <= maxGap && !hasFigureBoundary(mapping, caption, pageMappings)
      })
      const charts = nearestCompositeRow(candidates, pageMappings, captionBox)
      if (charts.length < 2) {
        previousCaptionBottom = Math.max(previousCaptionBottom, captionBox.bbox[3])
        continue
      }

      const chartUnion = unionBoxes(charts.map((mapping) => primaryBox(mapping)!))
      const supporting = pageMappings.filter((mapping) =>
        mapping !== caption && !charts.includes(mapping) && isSupportingVisual(mapping, chartUnion, captionBox)
      )
      const visualMappings = [...charts, ...supporting].sort((left, right) => left.order - right.order)
      const cropBox = paddedBox(
        unionBoxes(visualMappings.map((mapping) => primaryBox(mapping)!)),
        captionBox.pageSize,
        CROP_PADDING_POINTS
      )
      const assetSources = charts.map((mapping) => mapping.sourceAsset!).filter(unique)
      const mappingIds = [...visualMappings.map((mapping) => mapping.id), caption.id].filter(unique)
      geometries.push({
        id: `reader-figure-${pageIndex}-${charts.map((chart) => chart.order).join('-')}`,
        pageIndex,
        cropBox,
        pageSize: captionBox.pageSize,
        mappingIds,
        assetSources,
        captionMappingId: caption.id,
        fallbackLegendText: supporting
          .filter((mapping) => !isSubfigureLabel(mapping.sourceText))
          .map((mapping) => mapping.sourceText.trim())
          .filter(Boolean)
          .join(' ')
      })
      charts.forEach((chart) => consumedAssets.add(chart.id))
      previousCaptionBottom = Math.max(previousCaptionBottom, captionBox.bbox[3])
    }
  }
  return geometries.sort((left, right) => left.pageIndex - right.pageIndex || left.cropBox[1] - right.cropBox[1])
}

export function projectReaderFigureGroups(
  geometries: readonly ReaderFigureGeometry[],
  blocks: readonly ReaderBlock[]
): ReaderFigureGroup[] {
  return geometries.flatMap((geometry) => {
    const memberBlockIndexes = blocks.flatMap((block, index) =>
      block.mappingIds.some((id) => geometry.mappingIds.includes(id)) ||
      geometry.assetSources.some((asset) => containsAsset(block.markdown, asset))
        ? [index]
        : []
    )
    if (memberBlockIndexes.length === 0) return []
    const captionBlockIndex = memberBlockIndexes.find((index) =>
      blocks[index]?.mappingIds.includes(geometry.captionMappingId)
    )
    if (captionBlockIndex === undefined) return []
    const split = splitFigureCaption(blocks[captionBlockIndex]?.markdown ?? '')
    if (!split) return []
    return [{
      ...geometry,
      fallbackLegendMarkdown: split.legendMarkdown || geometry.fallbackLegendText,
      ownerBlockIndex: Math.min(...memberBlockIndexes),
      captionBlockIndex,
      memberBlockIndexes,
      captionMarkdown: split.captionMarkdown,
      captionPrefixMarkdown: split.prefixMarkdown
    }]
  })
}

export function buildReaderFigureGroups(
  blocks: readonly ReaderBlock[],
  mappings: readonly BlockMapping[]
): ReaderFigureGroup[] {
  return projectReaderFigureGroups(buildReaderFigureGeometries(mappings), blocks)
}

function nearestCompositeRow(
  candidates: readonly BlockMapping[],
  pageMappings: readonly BlockMapping[],
  captionBox: BlockBox
): BlockMapping[] {
  if (candidates.length < 2) return []
  const nearest = [...candidates].sort((left, right) => primaryBox(right)!.bbox[3] - primaryBox(left)!.bbox[3])[0]!
  const row = candidates.filter((candidate) => candidate === nearest || sharesFigureRow(candidate, nearest))
    .sort((left, right) => primaryBox(left)!.bbox[0] - primaryBox(right)!.bbox[0])
  if (row.length < 2 || !horizontallySeparated(row)) return []
  if (row.every((candidate) => overlapRatio(primaryBox(candidate)!, primaryBox(nearest)!) >= MIN_VERTICAL_OVERLAP)) return row
  const labels = pageMappings.filter((mapping) => isSubfigureLabel(mapping.sourceText) && primaryBox(mapping))
  return row.every((chart) => labels.some((label) => labelBelongsToChart(primaryBox(label)!, primaryBox(chart)!, captionBox)))
    ? row
    : []
}

function isSharedCaptionCandidate(mapping: BlockMapping): boolean {
  const box = primaryBox(mapping)
  if (!box || normalizeType(mapping.type) !== 'chart_caption' || isSubfigureLabel(mapping.sourceText)) return false
  return FIGURE_CAPTION_PREFIX.test(mapping.sourceText) || width(box.bbox) >= box.pageSize[0] * SHARED_CAPTION_MIN_PAGE_WIDTH
}

function isSupportingVisual(
  mapping: BlockMapping,
  chartUnion: [number, number, number, number],
  captionBox: BlockBox
): boolean {
  const box = primaryBox(mapping)
  const type = normalizeType(mapping.type)
  if (!box || !SUPPORTING_TYPES.has(type) || box.bbox[3] > captionBox.bbox[1] + 2) return false
  if (isSubfigureLabel(mapping.sourceText)) {
    return box.bbox[1] >= chartUnion[1] && box.bbox[0] <= chartUnion[2] && box.bbox[2] >= chartUnion[0]
  }
  if (!mapping.sourceText.trim() || mapping.sourceText.length > 500) return false
  const verticalOverlap = intervalOverlap(box.bbox[1], box.bbox[3], chartUnion[1], chartUnion[3])
  const besideCharts = verticalOverlap > 0 && box.bbox[0] >= chartUnion[0] - 4 && box.bbox[0] <= captionBox.pageSize[0]
  const belowCharts = box.bbox[1] >= chartUnion[3] - 4 && box.bbox[1] <= captionBox.bbox[1]
  return type === 'chart_footnote' ? besideCharts || belowCharts : besideCharts
}

function hasFigureBoundary(
  asset: BlockMapping,
  caption: BlockMapping,
  pageMappings: readonly BlockMapping[]
): boolean {
  return pageMappings.some((mapping) => {
    if (mapping.order <= asset.order || mapping.order >= caption.order) return false
    const type = normalizeType(mapping.type)
    return type.includes('table') || (type === 'text' && mapping.sourceText.trim().length > 500)
  })
}

function splitFigureCaption(markdown: string): {
  prefixMarkdown: string
  captionMarkdown: string
  legendMarkdown: string
} | null {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const textual = lines.map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line && !/^!\[.*\]\([^)]*\)\s*[\\ ]*$/u.test(line))
  if (textual.length === 0) return null
  const caption = [...textual].reverse().find(({ line }) => !isSubfigureLabel(line))
  if (!caption) return null
  const legend = [...textual].reverse().find(({ index, line }) => index < caption.index && !isSubfigureLabel(line))
  return {
    prefixMarkdown: lines.slice(0, caption.index).join('\n').trimEnd(),
    captionMarkdown: caption.line.replace(/[\\ ]+$/u, ''),
    legendMarkdown: (legend?.line ?? '').replace(/[\\ ]+$/u, '')
  }
}

function sharesFigureRow(left: BlockMapping, right: BlockMapping): boolean {
  const leftBox = primaryBox(left)!
  const rightBox = primaryBox(right)!
  return overlapRatio(leftBox, rightBox) >= MIN_VERTICAL_OVERLAP ||
    Math.abs(leftBox.bbox[1] - rightBox.bbox[1]) <= leftBox.pageSize[1] * 0.04
}

function horizontallySeparated(mappings: readonly BlockMapping[]): boolean {
  for (let index = 1; index < mappings.length; index += 1) {
    if (primaryBox(mappings[index - 1])!.bbox[2] > primaryBox(mappings[index])!.bbox[0] + 2) return false
  }
  return true
}

function labelBelongsToChart(label: BlockBox, chart: BlockBox, caption: BlockBox): boolean {
  const center = (label.bbox[0] + label.bbox[2]) / 2
  return center >= chart.bbox[0] && center <= chart.bbox[2] &&
    label.bbox[1] >= chart.bbox[3] - 4 && label.bbox[3] <= caption.bbox[1] + 2
}

function overlapRatio(left: BlockBox, right: BlockBox): number {
  const overlap = intervalOverlap(left.bbox[1], left.bbox[3], right.bbox[1], right.bbox[3])
  return overlap / Math.max(1, Math.min(height(left.bbox), height(right.bbox)))
}

function intervalOverlap(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB))
}

function primaryBox(mapping: BlockMapping | undefined): BlockBox | undefined {
  return mapping?.boxes.find((box) => !box.isDiscarded)
}

function unionBoxes(boxes: readonly BlockBox[]): [number, number, number, number] {
  return [
    Math.min(...boxes.map((box) => box.bbox[0])),
    Math.min(...boxes.map((box) => box.bbox[1])),
    Math.max(...boxes.map((box) => box.bbox[2])),
    Math.max(...boxes.map((box) => box.bbox[3]))
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

function isSubfigureLabel(value: string): boolean {
  return SUBFIGURE_LABEL.test(value.trim())
}

function unique<T>(value: T, index: number, values: T[]): boolean {
  return values.indexOf(value) === index
}

function width(box: readonly [number, number, number, number]): number {
  return Math.max(0, box[2] - box[0])
}

function height(box: readonly [number, number, number, number]): number {
  return Math.max(0, box[3] - box[1])
}
