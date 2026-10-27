import type { BlockBox, BlockMapping } from '@features/parsing/contract/blocks'
import { clampFraction } from '../readerScrollSync'

/** PDF page layout, scroll anchoring, sync positions, canvas sizing and merge connectors; no React. */

export const PDF_VIEWPORT_FOCUS = 0.45
export const PDF_MAX_CANVAS_PIXELS = 8 * 1024 * 1024
export const PDF_MAX_CANVAS_DIMENSION = 8192

/** Scroll extent and offset of the PDF scroller, as read for the floating scrollbars. */
export interface ScrollMetrics {
  width: number
  height: number
  contentWidth: number
  contentHeight: number
  left: number
  top: number
}

export const DEFAULT_PDF_PAGE_SIZE: PdfBaseSize = Object.freeze({ width: 612, height: 792 })
export const EMPTY_PAGE_MAPPINGS: BlockMapping[] = []

export interface PdfBaseSize {
  width: number
  height: number
}

export function indexMappingsByPage(mappings: BlockMapping[], pageCount: number): BlockMapping[][] {
  const pages = Array.from({ length: pageCount }, () => [] as BlockMapping[])
  for (const mapping of mappings) {
    const seen = new Set<number>()
    for (const box of mapping.boxes) {
      if (box.pageIndex < 0 || box.pageIndex >= pageCount || seen.has(box.pageIndex)) continue
      pages[box.pageIndex]?.push(mapping)
      seen.add(box.pageIndex)
    }
  }
  return pages
}

export interface PdfPageLayout {
  pages: Array<{ top: number; width: number; height: number }>
  totalHeight: number
}

export interface PdfScrollAnchor {
  pageIndex: number
  pageFraction: number
  viewportFraction: number
}

export function capturePdfScrollAnchor(layout: PdfPageLayout, scrollTop: number, viewportHeight: number): PdfScrollAnchor | null {
  const focusOffset = scrollTop + viewportHeight * PDF_VIEWPORT_FOCUS
  const pageIndex = pageIndexAtOffset(layout, focusOffset)
  const page = layout.pages[pageIndex]
  if (!page) return null
  return {
    pageIndex,
    pageFraction: Math.max(0, Math.min(1, (focusOffset - page.top) / page.height)),
    viewportFraction: PDF_VIEWPORT_FOCUS
  }
}

export function pdfScrollTopForAnchor(layout: PdfPageLayout, anchor: PdfScrollAnchor, viewportHeight: number): number {
  const page = layout.pages[anchor.pageIndex]
  if (!page) return 0
  const requested = page.top + page.height * anchor.pageFraction - viewportHeight * anchor.viewportFraction
  return Math.max(0, Math.min(Math.max(0, layout.totalHeight - viewportHeight), requested))
}

export function buildPdfPageLayout(
  pageSizes: readonly PdfBaseSize[],
  contentWidth: number,
  zoom: number
): PdfPageLayout {
  let consumed = 0
  const pages = pageSizes.map((size) => {
    const top = consumed
    const metrics = pdfPageMetrics(size, contentWidth, zoom)
    consumed += metrics.height
    return { top, width: metrics.width, height: metrics.height }
  })
  return { pages, totalHeight: consumed }
}

export function pageIndexAtOffset(layout: PdfPageLayout, offset: number): number {
  if (layout.pages.length === 0) return 0
  let low = 0
  let high = layout.pages.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((layout.pages[middle]?.top ?? 0) <= offset) low = middle + 1
    else high = middle
  }
  if (low >= layout.pages.length) return layout.pages.length - 1
  return Math.max(0, low - 1)
}

export function pdfRenderWindow(currentPageIndex: number, pageCount: number, radius: number): { start: number; end: number } {
  const safeCurrent = Math.min(Math.max(0, currentPageIndex), Math.max(0, pageCount - 1))
  return {
    start: Math.max(0, safeCurrent - radius),
    end: Math.min(pageCount, safeCurrent + radius + 1)
  }
}

export function remainingPdfLayoutHeight(layout: PdfPageLayout, firstHiddenPage: number): number {
  return Math.max(0, layout.totalHeight - (layout.pages[firstHiddenPage]?.top ?? layout.totalHeight))
}

/** The mapped block on the reading line (innermost containing box, else the nearest one) and how far through it. */
export function pdfSyncPosition(
  layout: PdfPageLayout,
  mappingsByPage: readonly BlockMapping[][],
  offset: number
): { mappingId: string; fraction: number } | null {
  if (layout.pages.length === 0) return null
  const pageIndex = pageIndexAtOffset(layout, offset)
  const page = layout.pages[pageIndex]
  if (!page || page.height <= 0) return null
  const pageFraction = (offset - page.top) / page.height
  let best: { mappingId: string; fraction: number; distance: number; span: number } | null = null
  for (const mapping of mappingsByPage[pageIndex] ?? []) {
    for (const box of mapping.boxes) {
      if (box.pageIndex !== pageIndex || box.isDiscarded || box.pageSize[1] <= 0) continue
      const top = box.bbox[1] / box.pageSize[1]
      const bottom = box.bbox[3] / box.pageSize[1]
      const span = Math.max(bottom - top, 1e-6)
      const distance = pageFraction < top ? top - pageFraction : pageFraction > bottom ? pageFraction - bottom : 0
      if (!best || distance < best.distance || (distance === best.distance && span < best.span)) {
        best = { mappingId: mapping.id, fraction: clampFraction((pageFraction - top) / span), distance, span }
      }
    }
  }
  return best ? { mappingId: best.mappingId, fraction: best.fraction } : null
}

export function findTargetBox(mapping: BlockMapping, blockPosition?: string): BlockBox | undefined {
  return (
    (blockPosition ? mapping.boxes.find((box) => box.blockPosition === blockPosition) : undefined) ??
    mapping.boxes.find((box) => box.mergeRole === 'source') ??
    mapping.boxes[0]
  )
}

export function pdfPageMetrics(
  baseSize: { width: number; height: number },
  contentWidth: number,
  zoom: number
): { scale: number; width: number; height: number } {
  const safeWidth = Number.isFinite(contentWidth) && contentWidth > 0 ? contentWidth : baseSize.width
  const safeZoom = Number.isFinite(zoom) ? Math.min(2, Math.max(0.6, zoom)) : 1
  const scale = baseSize.width > 0 ? safeWidth / baseSize.width * safeZoom : safeZoom
  return { scale, width: baseSize.width * scale, height: baseSize.height * scale }
}

export function pdfCanvasOutput(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number
): { width: number; height: number; scale: number } {
  const safeWidth = Math.max(1, Number.isFinite(cssWidth) ? cssWidth : 1)
  const safeHeight = Math.max(1, Number.isFinite(cssHeight) ? cssHeight : 1)
  const safeDeviceScale = Math.max(1, Math.min(2, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1))
  const dimensionScale = Math.min(PDF_MAX_CANVAS_DIMENSION / safeWidth, PDF_MAX_CANVAS_DIMENSION / safeHeight)
  const pixelScale = Math.sqrt(PDF_MAX_CANVAS_PIXELS / (safeWidth * safeHeight))
  const scale = Math.max(Number.EPSILON, Math.min(safeDeviceScale, dimensionScale, pixelScale))
  return {
    width: Math.max(1, Math.floor(safeWidth * scale)),
    height: Math.max(1, Math.floor(safeHeight * scale)),
    scale
  }
}

export function readPdfContentWidth(scroller: HTMLElement): number {
  const style = window.getComputedStyle(scroller)
  const padding = numericPixels(style.paddingLeft) + numericPixels(style.paddingRight)
  return Math.max(0, scroller.clientWidth - padding)
}

export function numericPixels(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export interface MergeConnector {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
}

export function buildMergeConnectors(
  mappings: BlockMapping[],
  pageIndex: number,
  size: { width: number; height: number }
): MergeConnector[] {
  const connectors: MergeConnector[] = []
  for (const mapping of mappings) {
    if (mapping.boxes.length < 2) continue
    for (let index = 0; index < mapping.boxes.length - 1; index += 1) {
      const source = mapping.boxes[index]
      const target = mapping.boxes[index + 1]
      if (!source || !target) continue
      if (source.pageIndex === pageIndex && target.pageIndex === pageIndex) {
        const points = closestConnection(normalizeBox(source, size), normalizeBox(target, size))
        connectors.push({ key: `${mapping.id}-${index}`, ...points })
      } else if (source.pageIndex === pageIndex && target.pageIndex > pageIndex) {
        const box = normalizeBox(source, size)
        connectors.push({
          key: `${mapping.id}-${index}-out`,
          x1: (box.left + box.right) / 2,
          y1: box.bottom,
          x2: (box.left + box.right) / 2,
          y2: size.height
        })
      } else if (target.pageIndex === pageIndex && source.pageIndex < pageIndex) {
        const box = normalizeBox(target, size)
        connectors.push({
          key: `${mapping.id}-${index}-in`,
          x1: (box.left + box.right) / 2,
          y1: 0,
          x2: (box.left + box.right) / 2,
          y2: box.top
        })
      }
    }
  }
  return connectors
}

export function normalizeBox(box: BlockBox, size: { width: number; height: number }): { left: number; top: number; right: number; bottom: number } {
  const [pageWidth, pageHeight] = box.pageSize
  return {
    left: (box.bbox[0] / pageWidth) * size.width,
    top: (box.bbox[1] / pageHeight) * size.height,
    right: (box.bbox[2] / pageWidth) * size.width,
    bottom: (box.bbox[3] / pageHeight) * size.height
  }
}

export function closestConnection(
  source: { left: number; top: number; right: number; bottom: number },
  target: { left: number; top: number; right: number; bottom: number }
): Omit<MergeConnector, 'key'> {
  const sourceCenter = { x: (source.left + source.right) / 2, y: (source.top + source.bottom) / 2 }
  const targetCenter = { x: (target.left + target.right) / 2, y: (target.top + target.bottom) / 2 }
  if (Math.abs(targetCenter.x - sourceCenter.x) > Math.abs(targetCenter.y - sourceCenter.y)) {
    return targetCenter.x >= sourceCenter.x
      ? { x1: source.right, y1: sourceCenter.y, x2: target.left, y2: targetCenter.y }
      : { x1: source.left, y1: sourceCenter.y, x2: target.right, y2: targetCenter.y }
  }
  return targetCenter.y >= sourceCenter.y
    ? { x1: sourceCenter.x, y1: source.bottom, x2: targetCenter.x, y2: target.top }
    : { x1: sourceCenter.x, y1: source.top, x2: targetCenter.x, y2: target.bottom }
}

export function blockTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    text: '文本',
    ref_text: '文本',
    title: '标题',
    image: '图片',
    chart: '图表',
    table: '表格',
    interline_equation: '公式',
    equation: '公式',
    page_header: '页眉',
    header: '页眉',
    page_footer: '页脚',
    footer: '页脚',
    page_footnote: '脚注',
    page_number: '页码'
  }
  return labels[type] ?? '区块'
}

export function pdfErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (error.name === 'InvalidPDFException') return 'PDF 文件已损坏或格式无效。'
  if (error.name === 'MissingPDFException') return '本地 PDF 文件不存在。'
  if (error.name === 'PasswordException') return '该 PDF 受密码保护，当前阅读器无法打开。'
  if (error.name === 'UnexpectedResponseException') return '读取本地 PDF 时返回了异常响应，请重试。'
  return error.message || '加载 PDF 时发生未知错误。'
}

export function isRenderingCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException'
}
