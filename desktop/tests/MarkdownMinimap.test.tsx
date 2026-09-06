// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MarkdownMinimap, {
  measureMarkdownMinimapItems,
  minimapFrameMetrics
} from '../src/renderer/components/MarkdownMinimap'

afterEach(() => cleanup())

describe('MarkdownMinimap', () => {
  it('measures document content and indents headings by level', () => {
    const scroller = document.createElement('div')
    const article = document.createElement('article')
    article.innerHTML = '<div class="markdown-block"><h1>Overview</h1><h2>Method</h2><h3>Details</h3><h4>Case</h4><h5>Note</h5><h6>Leaf</h6><p>Body paragraph with enough text.</p></div>'
    scroller.append(article)
    setElementMetrics(scroller, { clientHeight: 200, scrollHeight: 1_000, scrollTop: 100 })
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect(0, 10, 400, 200))
    const elements = Array.from(article.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, p'))
    elements.forEach((element, index) => {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect(0, 110 + index * 40, 300, 24))
    })

    const items = measureMarkdownMinimapItems(article, scroller, 500)

    expect(items).toHaveLength(7)
    expect(items[0]).toMatchObject({ headingLevel: 1, title: 'Overview', left: 4, top: 100 })
    expect(items.slice(0, 6).map((item) => item.left)).toEqual([4, 10, 16, 22, 28, 34])
    expect(items[6]).toMatchObject({ headingLevel: null, left: 5 })
  })

  it('calculates the viewport frame and handles documents without overflow', () => {
    expect(minimapFrameMetrics({ clientHeight: 200, scrollHeight: 1_000, scrollTop: 400 }, 400))
      .toEqual({ top: 160, height: 80, maxScroll: 800 })
    expect(minimapFrameMetrics({ clientHeight: 500, scrollHeight: 500, scrollTop: 100 }, 400))
      .toEqual({ top: 0, height: 400, maxScroll: 0 })
  })

  it('previews, jumps, drags, wheels and supports keyboard navigation', async () => {
    const view = render(<Harness revision={0} />)
    const scroller = view.container.querySelector<HTMLElement>('.markdown-scroll')!
    const rail = view.getByRole('scrollbar', { name: 'Markdown 文档缩略导航' })
    setElementMetrics(scroller, { clientHeight: 200, scrollHeight: 1_000, scrollTop: 0 })
    Object.defineProperty(rail, 'clientHeight', { configurable: true, value: 400 })
    vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 84, 400))
    const heading = view.container.querySelector('h2')!
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 200))
    vi.spyOn(heading, 'getBoundingClientRect').mockReturnValue(rect(0, 100, 300, 30))
    const scrollTo = vi.fn()
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo })

    view.rerender(<Harness revision={1} />)
    const frame = view.container.querySelector<HTMLElement>('.markdown-minimap-frame')!
    await waitFor(() => expect(view.getByRole('button', { name: '跳转到Chapter' })).toBeTruthy())
    expect(frame.style.getPropertyValue('--markdown-minimap-frame-height')).toBe('80px')

    fireEvent.pointerMove(rail, { clientY: 300 })
    expect(frame.dataset.preview).toBe('true')
    expect(frame.style.getPropertyValue('--markdown-minimap-frame-top')).toBe('260px')
    expect(scroller.scrollTop).toBe(0)

    fireEvent.pointerDown(rail, { clientY: 300, pointerId: 1 })
    expect(scroller.scrollTop).toBe(650)
    fireEvent.pointerMove(rail, { clientY: 100, pointerId: 1 })
    expect(scroller.scrollTop).toBe(150)
    fireEvent.pointerUp(rail, { pointerId: 1 })

    fireEvent.wheel(rail, { deltaY: 50 })
    expect(scroller.scrollTop).toBe(200)
    fireEvent.keyDown(rail, { key: 'PageDown' })
    expect(scroller.scrollTop).toBe(400)
    fireEvent.keyDown(rail, { key: 'End' })
    expect(scroller.scrollTop).toBe(800)
    fireEvent.keyDown(rail, { key: 'Home' })
    expect(scroller.scrollTop).toBe(0)

    fireEvent.click(view.getByRole('button', { name: '跳转到Chapter' }))
    expect(scrollTo).toHaveBeenCalledWith({ top: 84, behavior: 'smooth' })
  })
})

function Harness(props: { revision: number }): React.JSX.Element {
  const scrollerRef = React.useRef<HTMLDivElement>(null)
  const articleRef = React.useRef<HTMLElement>(null)
  return (
    <div>
      <div ref={scrollerRef} className="markdown-scroll" id="markdown-test-document">
        <article ref={articleRef}>
          <div className="markdown-block"><h2>Chapter</h2></div>
        </article>
      </div>
      <MarkdownMinimap
        active
        ready
        layoutRevision={props.revision}
        controlledId="markdown-test-document"
        scrollerRef={scrollerRef}
        articleRef={articleRef}
      />
    </div>
  )
}

function setElementMetrics(
  element: HTMLElement,
  metrics: { clientHeight: number; scrollHeight: number; scrollTop: number }
): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: metrics.clientHeight },
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    scrollTop: { configurable: true, writable: true, value: metrics.scrollTop }
  })
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({})
  }
}
