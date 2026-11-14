import type { ReaderBlock } from '../../core/readerDocument'

/** DOM, timing and comparison helpers of MarkdownPane. */

export interface BlockPosition {
  mappingId: string
  center: number
}

export function readerBlocksEqual(left: ReaderBlock[], right: ReaderBlock[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((block, index) => {
    const candidate = right[index]
    return candidate !== undefined &&
      block.role === candidate.role &&
      block.markdown === candidate.markdown &&
      block.annotationKey === candidate.annotationKey &&
      block.text === candidate.text &&
      block.pageIndex === candidate.pageIndex &&
      block.order === candidate.order &&
      block.fallbackProvider === candidate.fallbackProvider &&
      block.edit?.edited === candidate.edit?.edited &&
      block.edit?.stale === candidate.edit?.stale &&
      block.boxed === candidate.boxed &&
      block.sourceChanged === candidate.sourceChanged &&
      stringArraysEqual(block.mappingIds, candidate.mappingIds)
  })
}

export function stringArraysEqual(left: string[], right: string[]): boolean {
  return left === right || (left.length === right.length && left.every((value, index) => value === right[index]))
}

export function nearestBlockPosition(positions: BlockPosition[], target: number): BlockPosition | null {
  if (positions.length === 0) return null
  let low = 0
  let high = positions.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const position = positions[middle]
    if (position && position.center < target) low = middle + 1
    else high = middle
  }
  const after = positions[Math.min(low, positions.length - 1)]
  const before = positions[Math.max(0, low - 1)]
  if (!after) return before ?? null
  if (!before) return after
  return Math.abs(after.center - target) < Math.abs(before.center - target) ? after : before
}

export async function waitForImage(image: HTMLImageElement, signal: AbortSignal): Promise<void> {
  if (!image.complete) await waitForImageEvent(image, signal)
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  try {
    await image.decode()
  } catch (error) {
    if (!image.complete || image.naturalWidth === 0) throw error
  }
  if (image.naturalWidth === 0) {
    throw new Error(`图片加载失败：${image.currentSrc || image.src || '未知资源'}`)
  }
}

export function waitForImageEvent(image: HTMLImageElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      image.removeEventListener('load', onLoad)
      image.removeEventListener('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const onLoad = (): void => {
      cleanup()
      resolve()
    }
    const onError = (): void => {
      cleanup()
      reject(new Error(`图片加载失败：${image.currentSrc || image.src || '未知资源'}`))
    }
    const onAbort = (): void => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    image.addEventListener('load', onLoad, { once: true })
    image.addEventListener('error', onError, { once: true })
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function waitForAnimationFrames(count: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let remaining = count
    const next = (): void => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      remaining -= 1
      if (remaining <= 0) resolve()
      else window.requestAnimationFrame(next)
    }
    window.requestAnimationFrame(next)
  })
}

/** Text of the paragraph, not a link, button, figure or note control placed in it. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !target.closest('a, button, img, canvas, input, textarea, select, [data-reader-annotation-ignore], .reader-figure-snapshot, .reader-figure-mosaic')
}

export function readableRenderError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Markdown 资源加载失败，请重新加载。'
}

export function parseMappingIds(value: string | undefined): string[] {
  return value?.split(/\s+/).filter(Boolean) ?? []
}
