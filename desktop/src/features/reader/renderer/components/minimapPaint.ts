import { type MarkdownMinimapImage, type MarkdownMinimapFormula, type MarkdownMinimapContent, type MarkdownMinimapGeometry } from './minimapTypes'

/** Painting the minimap canvas, its formula layer and viewport frame, and scroll helpers. */

export const MINIMAP_FRAME_MIN_HEIGHT = 24

export function paintMarkdownMinimap(
  canvas: HTMLCanvasElement,
  content: MarkdownMinimapContent,
  width: number,
  height: number,
  pixelRatio: number,
  providedContext?: CanvasRenderingContext2D
): void {
  const ratio = Math.max(1, pixelRatio)
  canvas.width = Math.max(1, Math.round(width * ratio))
  canvas.height = Math.max(1, Math.round(height * ratio))
  const context = providedContext ?? (typeof CanvasRenderingContext2D === 'undefined' ? null : canvas.getContext('2d'))
  if (!context) return
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, width, height)
  const railStyle = window.getComputedStyle(canvas.parentElement ?? canvas)
  const textColor = railStyle.getPropertyValue('--text').trim() || '#3f3a34'
  const mutedColor = railStyle.getPropertyValue('--muted').trim() || '#756e65'

  context.fillStyle = '#f4c542'
  context.globalAlpha = 0.58
  for (const highlight of content.highlights) {
    context.fillRect(highlight.left, highlight.top, highlight.width, highlight.height)
  }

  context.strokeStyle = mutedColor
  context.lineWidth = 0.75
  for (const image of content.images) {
    const target = containRect(image.sourceWidth, image.sourceHeight, image)
    try {
      if (!minimapImageReady(image.element)) {
        throw new Error('minimap image is unavailable')
      }
      context.globalAlpha = 0.82
      context.drawImage(image.element, target.left, target.top, target.width, target.height)
    } catch {
      context.globalAlpha = 0.32
      context.strokeRect(target.left, target.top, target.width, target.height)
    }
  }

  context.textBaseline = 'alphabetic'
  for (const run of content.textRuns) {
    context.globalAlpha = run.tone === 'heading' ? 0.82 : run.tone === 'code' ? 0.62 : 0.48
    context.fillStyle = run.tone === 'body' ? mutedColor : textColor
    const family = run.tone === 'code' ? 'Consolas, "SFMono-Regular", monospace' : 'Inter, "Microsoft YaHei UI", sans-serif'
    context.font = `${run.fontStyle} ${run.fontWeight} ${run.fontSize}px ${family}`
    context.fillText(run.text, run.left, run.baseline, run.width)
  }
  context.globalAlpha = 1
}

export function minimapImageReady(element: HTMLImageElement | HTMLCanvasElement): boolean {
  return element instanceof HTMLCanvasElement
    ? element.width > 0 && element.height > 0
    : element.complete && element.naturalWidth > 0 && element.naturalHeight > 0
}

export function containRect(
  sourceWidth: number,
  sourceHeight: number,
  target: Pick<MarkdownMinimapImage, 'left' | 'top' | 'width' | 'height'>
): { left: number; top: number; width: number; height: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0 || target.width <= 0 || target.height <= 0) {
    return { left: target.left, top: target.top, width: 0, height: 0 }
  }
  const scale = Math.min(target.width / sourceWidth, target.height / sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale
  return {
    left: target.left + (target.width - width) / 2,
    top: target.top + (target.height - height) / 2,
    width,
    height
  }
}

export function renderFormulaLayer(layer: HTMLElement, formulas: MarkdownMinimapFormula[]): void {
  const fragment = document.createDocumentFragment()
  for (const formula of formulas) {
    const target = containRect(formula.sourceWidth, formula.sourceHeight, formula)
    if (target.width <= 0 || target.height <= 0) continue
    const holder = document.createElement('span')
    holder.className = 'markdown-minimap-formula'
    holder.setAttribute('aria-hidden', 'true')
    holder.inert = true
    holder.style.left = `${target.left}px`
    holder.style.top = `${target.top}px`
    holder.style.width = `${formula.sourceWidth}px`
    holder.style.height = `${formula.sourceHeight}px`
    holder.style.color = formula.color
    holder.style.fontFamily = formula.fontFamily
    holder.style.fontSize = formula.fontSize
    holder.style.transform = `scale(${target.width / formula.sourceWidth})`
    const clone = formula.element.cloneNode(true) as HTMLElement
    clone.removeAttribute('id')
    for (const descendant of clone.querySelectorAll<HTMLElement>('[id]')) descendant.removeAttribute('id')
    holder.append(clone)
    fragment.append(holder)
  }
  layer.replaceChildren(fragment)
}

export function minimapFrameMetrics(
  scrollTop: number,
  geometry: MarkdownMinimapGeometry
): FrameMetrics {
  if (geometry.railHeight <= 0 || geometry.documentHeight <= 0 || geometry.maxScroll === 0) {
    return frameDisplayMetrics(0, Math.max(0, geometry.railHeight), geometry.railHeight)
  }
  const height = Math.min(geometry.railHeight, geometry.viewportHeight * geometry.verticalScale)
  const top = clamp(scrollTop, 0, geometry.maxScroll) * geometry.verticalScale
  return frameDisplayMetrics(top, height, geometry.railHeight, geometry.maxScroll)
}

export function createMarkdownMinimapGeometry(
  scroller: Pick<HTMLElement, 'clientHeight' | 'scrollHeight'>,
  railWidth: number,
  railHeight: number
): MarkdownMinimapGeometry {
  const documentHeight = Math.max(0, scroller.scrollHeight)
  const viewportHeight = Math.max(0, scroller.clientHeight)
  return {
    railWidth: Math.max(0, railWidth),
    railHeight: Math.max(0, railHeight),
    documentHeight,
    viewportHeight,
    verticalScale: documentHeight > 0 ? Math.max(0, railHeight) / documentHeight : 0,
    maxScroll: Math.max(0, documentHeight - viewportHeight)
  }
}

export function maximumScroll(scroller: Pick<HTMLElement, 'clientHeight' | 'scrollHeight'>): number {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight)
}

export function setScrollerTop(scroller: HTMLElement, target: number): void {
  scroller.scrollTop = clamp(target, 0, maximumScroll(scroller))
}

export function scrollScrollerTo(scroller: HTMLElement, target: number): void {
  const top = clamp(target, 0, maximumScroll(scroller))
  if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top, behavior: 'smooth' })
  else scroller.scrollTop = top
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export interface DragMetrics {
  railTop: number
  railHeight: number
}

export interface FrameMetrics {
  top: number
  height: number
  hitTop: number
  hitHeight: number
  maxScroll: number
}

export function frameDisplayMetrics(top: number, height: number, railHeight: number, maxScroll = 0): FrameMetrics {
  const hitHeight = Math.min(railHeight, Math.max(MINIMAP_FRAME_MIN_HEIGHT, height))
  const center = top + height / 2
  return {
    top,
    height,
    hitTop: clamp(center - hitHeight / 2, 0, Math.max(0, railHeight - hitHeight)),
    hitHeight,
    maxScroll
  }
}

export function writeFrameStyles(
  frame: HTMLElement,
  hit: HTMLElement | null,
  metrics: FrameMetrics,
  preview: boolean
): void {
  frame.style.setProperty('--markdown-minimap-frame-offset', `${metrics.top}px`)
  frame.style.setProperty('--markdown-minimap-frame-height', `${metrics.height}px`)
  frame.dataset.preview = String(preview)
  hit?.style.setProperty('--markdown-minimap-frame-hit-offset', `${metrics.hitTop}px`)
  hit?.style.setProperty('--markdown-minimap-frame-hit-height', `${metrics.hitHeight}px`)
}

export const emptyMinimapGeometry: MarkdownMinimapGeometry = {
  railWidth: 0,
  railHeight: 0,
  documentHeight: 0,
  viewportHeight: 0,
  verticalScale: 0,
  maxScroll: 0
}
