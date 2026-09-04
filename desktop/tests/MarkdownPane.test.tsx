// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReaderBlock } from '@shared/readerDocument'
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
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: 120, right: 220, bottom: 144, left: 100, width: 120, height: 24, x: 100, y: 120, toJSON: () => ({}) })
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
        active
        blocks={blocks}
        assetBaseUrl="mineru-asset://task/"
        taskId="task"
        view="original"
        annotations={[]}
        highlightColor="yellow"
        onHighlightColorChange={() => undefined}
        onReplaceAnnotations={async () => undefined}
        selection={{ mappingId: 'image', origin: 'markdown' }}
        onSelect={onSelect}
      />
    )
    expect(view.container.querySelector('img')).toBe(image)
    expect(decodeImage).toHaveBeenCalledTimes(1)
  })

  it('keeps a ready pane stable when equivalent blocks arrive in a new array', async () => {
    const selection: BlockSelection = { mappingId: 'image', origin: 'pdf', blockPosition: '0-1' }
    const blocks = [block('image', 'Before\n\n![figure](images/figure.png)\n\nAfter')]
    const view = renderPane(blocks, selection, vi.fn())
    const scroller = view.container.querySelector<HTMLElement>('.markdown-scroll')!
    const article = view.container.querySelector('article')!
    const image = view.container.querySelector('img')!

    fireEvent.load(image)
    await waitFor(() => expect(scroller.getAttribute('data-render-state')).toBe('ready'))
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    scroller.scrollTop = 420

    view.rerender(
      <MarkdownPane
        active
        blocks={blocks.map((item) => ({ ...item, mappingIds: [...item.mappingIds] }))}
        assetBaseUrl="mineru-asset://task/"
        taskId="task"
        view="original"
        annotations={[]}
        highlightColor="yellow"
        onHighlightColorChange={() => undefined}
        onReplaceAnnotations={async () => undefined}
        selection={selection}
        onSelect={() => undefined}
      />
    )

    expect(scroller.getAttribute('data-render-state')).toBe('ready')
    expect(view.container.querySelector('article')).toBe(article)
    expect(view.container.querySelector('img')).toBe(image)
    expect(scroller.scrollTop).toBe(420)
    expect(decodeImage).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)

    view.rerender(
      <MarkdownPane
        active
        blocks={blocks}
        assetBaseUrl="mineru-asset://task/"
        taskId="task"
        view="original"
        annotations={[]}
        highlightColor="yellow"
        onHighlightColorChange={() => undefined}
        onReplaceAnnotations={async () => undefined}
        selection={{ ...selection }}
        onSelect={() => undefined}
      />
    )
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2))
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
      '<table><tbody><tr><th rowspan="2">Header</th><td colspan="2" onclick="alert(1)">Cell</td></tr><tr><td>Second</td><td>Third</td></tr></tbody></table>',
      '$E=mc^2$',
      '<a href="javascript:alert(1)">unsafe</a><script>alert(2)</script>'
    ].join('\n\n')
    const view = renderPane([block('academic', markdown)], null, vi.fn())
    await waitFor(() => expect(view.container.querySelector('.markdown-scroll')?.getAttribute('data-render-state')).toBe('ready'))

    expect(view.container.querySelector('sub')?.textContent).toBe('2')
    expect(view.container.querySelector('sup')?.textContent).toBe('12')
    expect(view.container.querySelector('td')?.textContent).toBe('Cell')
    expect(view.container.querySelector('td')?.hasAttribute('onclick')).toBe(false)
    expect(view.container.querySelector('th')?.getAttribute('rowspan')).toBe('2')
    expect(view.container.querySelector('td')?.getAttribute('colspan')).toBe('2')
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

  it('renders supplemental HTML as display-only gray content', async () => {
    const onSelect = vi.fn()
    const supplement: ReaderBlock = {
      role: 'footnote',
      markdown: '',
      text: '<sub>*</sub>. Equal contribution.',
      mappingIds: [],
      pageIndex: 0,
      order: 1
    }
    const view = renderPane([supplement], null, onSelect)
    await waitFor(() => expect(view.container.querySelector('.markdown-scroll')?.getAttribute('data-render-state')).toBe('ready'))

    const footnote = view.container.querySelector<HTMLElement>('[data-reader-role="footnote"]')!
    expect(footnote.querySelector('sub')?.textContent).toBe('*')
    expect(footnote.textContent).toContain('Equal contribution.')
    expect(footnote.hasAttribute('data-block-ids')).toBe(false)
    fireEvent.click(footnote)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('refuses PDF navigation when a mapping id belongs to multiple Markdown elements', async () => {
    const onSelect = vi.fn()
    const view = renderPane(
      [block('ambiguous', 'First'), block('ambiguous', 'Second')],
      { mappingId: 'ambiguous', origin: 'pdf' },
      onSelect
    )
    await waitFor(() => expect(view.container.querySelector('.markdown-scroll')?.getAttribute('data-render-state')).toBe('ready'))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(scrollIntoView).not.toHaveBeenCalled()
    for (const element of view.container.querySelectorAll<HTMLElement>('[data-block-ids="ambiguous"]')) {
      fireEvent.click(element)
    }
    fireEvent.scroll(view.container.querySelector('.markdown-scroll')!)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('annotates a cross-block selection, changes the current color without applying it, and exposes chat payloads', async () => {
    const onReplaceAnnotations = vi.fn().mockResolvedValue(undefined)
    const onAddToChat = vi.fn()
    const annotationBlocks: ReaderBlock[] = [
      { ...block('first', 'Alpha'), annotationKey: 'content:0' },
      { role: 'page-divider', markdown: '', text: '第 1 页', mappingIds: [], pageIndex: 0, order: 0.5 },
      { ...block('second', 'Bravo'), annotationKey: 'content:1', order: 1 }
    ]
    function Harness(): React.JSX.Element {
      const [color, setColor] = React.useState<'yellow' | 'green' | 'blue' | 'pink' | 'purple'>('yellow')
      return (
        <MarkdownPane
          active
          blocks={annotationBlocks}
          assetBaseUrl="mineru-asset://task/"
          taskId="task"
          view="original"
          annotations={[]}
          highlightColor={color}
          onHighlightColorChange={setColor}
          onReplaceAnnotations={onReplaceAnnotations}
          onAddToChat={onAddToChat}
          selection={null}
          onSelect={() => undefined}
        />
      )
    }
    const view = render(<Harness />)
    await waitFor(() => expect(view.container.querySelector('.markdown-scroll')?.getAttribute('data-render-state')).toBe('ready'))
    selectBetween(view.getByText('Alpha').firstChild!, 1, view.getByText('Bravo').firstChild!, 3)
    document.dispatchEvent(new Event('selectionchange'))

    const toolbar = await view.findByRole('toolbar', { name: '文本标注' })
    expect(toolbar.querySelectorAll(':scope > button')).toHaveLength(3)
    fireEvent.contextMenu(view.getByRole('button', { name: '荧光笔高亮' }))
    expect(view.getAllByRole('option')).toHaveLength(5)
    fireEvent.click(view.getByRole('option', { name: '选择蓝色' }))
    expect(onReplaceAnnotations).not.toHaveBeenCalled()
    expect(view.getByRole('button', { name: '荧光笔高亮' }).querySelector<HTMLElement>('.anticon')?.style.color).toBe('rgb(100, 168, 232)')

    fireEvent.click(view.getByRole('button', { name: '荧光笔高亮' }))
    await waitFor(() => expect(onReplaceAnnotations).toHaveBeenCalledTimes(1))
    const saved = onReplaceAnnotations.mock.calls[0]![0]
    expect(saved.map((annotation: { blockKey: string; quote: string; color: string }) =>
      [annotation.blockKey, annotation.quote, annotation.color])).toEqual([
      ['content:0', 'lpha', 'blue'],
      ['content:1', 'Bra', 'blue']
    ])

    selectBetween(view.getByText('Alpha').firstChild!, 0, view.getByText('Alpha').firstChild!, 5)
    document.dispatchEvent(new Event('selectionchange'))
    fireEvent.click(await view.findByRole('button', { name: '添加到对话' }))
    expect(onAddToChat).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task',
      view: 'original',
      text: 'Alpha'
    }))
  })
})

function selectBetween(startNode: Node, startOffset: number, endNode: Node, endOffset: number): void {
  const selection = window.getSelection()!
  selection.removeAllRanges()
  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  selection.addRange(range)
}

function block(mappingId: string, markdown: string): ReaderBlock {
  return { role: 'content', markdown, mappingIds: [mappingId], order: 0 }
}

function renderPane(
  blocks: ReaderBlock[],
  selection: BlockSelection | null,
  onSelect: (selection: BlockSelection) => void
): ReturnType<typeof render> {
  return render(
    <MarkdownPane
      active
      blocks={blocks}
      assetBaseUrl="mineru-asset://task/"
      taskId="task"
      view="original"
      annotations={[]}
      highlightColor="yellow"
      onHighlightColorChange={() => undefined}
      onReplaceAnnotations={async () => undefined}
      selection={selection}
      onSelect={onSelect}
    />
  )
}
