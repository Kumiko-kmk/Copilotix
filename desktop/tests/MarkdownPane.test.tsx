// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AlignedMarkdownBlock } from '@shared/markdownBlocks'
import type { BlockSelection } from '@shared/types'
import MarkdownPane from '../src/renderer/components/MarkdownPane'

let naturalWidth = 320
let decodeImage: ReturnType<typeof vi.fn>
let scrollIntoView: ReturnType<typeof vi.fn>

class ResizeObserverMock {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  naturalWidth = 320
  decodeImage = vi.fn().mockResolvedValue(undefined)
  scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  Object.defineProperty(HTMLImageElement.prototype, 'complete', {
    configurable: true,
    get: () => false
  })
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
    configurable: true,
    get: () => naturalWidth
  })
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: decodeImage
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView
  })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  vi.unstubAllGlobals()
})

describe('MarkdownPane', () => {
  it('reveals content only after images decode and does not rebuild images for selection changes', async () => {
    const blocks = [block('image', 'Before\n\n![figure](images/figure.png)\n\nAfter')]
    const onSelect = vi.fn()
    const view = renderPane(blocks, null, onSelect)
    const article = view.container.querySelector('article')!
    const image = view.container.querySelector('img')!

    expect(view.container.querySelector('.markdown-scroll')?.getAttribute('data-render-state')).toBe('loading')
    expect(article.getAttribute('aria-hidden')).toBe('true')
    expect(image.getAttribute('loading')).toBe('eager')

    fireEvent.load(image)
    await waitFor(() => expect(view.container.querySelector('.markdown-scroll')?.getAttribute('data-render-state')).toBe('ready'))
    expect(article.getAttribute('aria-hidden')).toBe('false')
    expect(decodeImage).toHaveBeenCalledTimes(1)

    view.rerender(
      <MarkdownPane
        blocks={blocks}
        assetBaseUrl="mineru-asset://task/"
        selection={{ mappingId: 'image', origin: 'markdown' }}
        onSelect={onSelect}
      />
    )
    expect(view.container.querySelector('img')).toBe(image)
    expect(decodeImage).toHaveBeenCalledTimes(1)
  })

  it('shows a complete-render error and retries with a fresh image tree', async () => {
    const view = renderPane([block('image', '![figure](images/broken.png)')], null, vi.fn())
    const firstImage = view.container.querySelector('img')!
    fireEvent.error(firstImage)

    await waitFor(() => expect(view.container.querySelector('.markdown-scroll')?.getAttribute('data-render-state')).toBe('error'))
    expect(view.getByText('Markdown 无法完整显示')).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: '重新加载' }))
    const secondImage = view.container.querySelector('img')!
    expect(secondImage).not.toBe(firstImage)
    fireEvent.load(secondImage)
    await waitFor(() => expect(view.container.querySelector('.markdown-scroll')?.getAttribute('data-render-state')).toBe('ready'))
  })

  it('shows a complete-render error when rendering exceeds 30 seconds', async () => {
    vi.useFakeTimers()
    const view = renderPane([block('image', '![figure](images/slow.png)')], null, vi.fn())

    expect(view.container.querySelector('.markdown-scroll')?.getAttribute('data-render-state')).toBe('loading')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(view.container.querySelector('.markdown-scroll')?.getAttribute('data-render-state')).toBe('error')
    expect(view.getByText('Markdown 资源加载超过 30 秒，请重新加载。')).toBeTruthy()
  })

  it('renders academic HTML and KaTeX while removing unsafe markup', async () => {
    const markdown = [
      'H<sub>2</sub>O and citation<sup>12</sup> keep literal <12>.',
      '<table><tbody><tr><td onclick="alert(1)">Cell</td></tr></tbody></table>',
      '$E=mc^2$',
      '<a href="javascript:alert(1)">unsafe</a><script>alert(2)</script>'
    ].join('\n\n')
    const view = renderPane([block('academic', markdown)], null, vi.fn())
    await waitFor(() => expect(view.container.querySelector('.markdown-scroll')?.getAttribute('data-render-state')).toBe('ready'))

    expect(view.container.querySelector('sub')?.textContent).toBe('2')
    expect(view.container.querySelector('sup')?.textContent).toBe('12')
    expect(view.container.querySelector('td')?.textContent).toBe('Cell')
    expect(view.container.querySelector('td')?.hasAttribute('onclick')).toBe(false)
    expect(view.container.querySelector('.katex')).toBeTruthy()
    expect(view.container.querySelector('script')).toBeNull()
    expect(view.getByText('unsafe').hasAttribute('href')).toBe(false)
    expect(view.container.textContent).toContain('<12>')
  })

  it('uses instant PDF navigation without feeding the synthetic scroll back into selection', async () => {
    const onSelect = vi.fn()
    scrollIntoView.mockImplementation(function (this: HTMLElement) {
      const scroller = this.closest('.markdown-scroll')
      if (scroller) fireEvent.scroll(scroller)
    })
    const selection: BlockSelection = { mappingId: 'target', origin: 'pdf', blockPosition: '0-1' }
    const view = renderPane(
      [block('start', 'Start'), block('target', 'Target')],
      selection,
      onSelect
    )

    await waitFor(() => expect(view.container.querySelector('.markdown-scroll')?.getAttribute('data-render-state')).toBe('ready'))
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('cancels a pending passive-scroll selection when a Markdown block is clicked', async () => {
    const onSelect = vi.fn()
    const view = renderPane(
      [block('start', 'Start'), block('target', 'Target')],
      null,
      onSelect
    )
    const scroller = view.container.querySelector('.markdown-scroll')!
    const target = view.container.querySelector<HTMLElement>('[data-block-ids="target"]')!
    await waitFor(() => expect(scroller.getAttribute('data-render-state')).toBe('ready'))

    fireEvent.scroll(scroller)
    fireEvent.click(target)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenLastCalledWith({ mappingId: 'target', origin: 'markdown' })
  })
})

function block(mappingId: string, markdown: string): AlignedMarkdownBlock {
  return { markdown, mappingIds: [mappingId] }
}

function renderPane(
  blocks: AlignedMarkdownBlock[],
  selection: BlockSelection | null,
  onSelect: (selection: BlockSelection) => void
): ReturnType<typeof render> {
  return render(
    <MarkdownPane
      blocks={blocks}
      assetBaseUrl="mineru-asset://task/"
      selection={selection}
      onSelect={onSelect}
    />
  )
}
