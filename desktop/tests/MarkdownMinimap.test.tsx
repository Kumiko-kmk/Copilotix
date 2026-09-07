// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MarkdownMinimap, {
  containRect,
  measureMarkdownMinimapContent,
  paintMarkdownMinimap,
  renderFormulaLayer,
  minimapFrameMetrics
} from '../src/renderer/components/MarkdownMinimap'

const canvasContext = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  drawImage: vi.fn(),
  strokeRect: vi.fn(),
  fillText: vi.fn(),
  strokeStyle: '',
  fillStyle: '',
  globalAlpha: 1,
  lineWidth: 1,
  textBaseline: 'alphabetic' as CanvasTextBaseline,
  font: ''
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.values(canvasContext).forEach((value) => {
    if (typeof value === 'function' && 'mockClear' in value) value.mockClear()
  })
})

describe('MarkdownMinimap', () => {
  it('measures document content and indents headings by level', () => {
    const scroller = document.createElement('div')
    const article = document.createElement('article')
    article.innerHTML = '<div class="markdown-block"><h1>Overview</h1><h2>Method</h2><h3>Details</h3><h4>Case</h4><h5>Note</h5><h6>Leaf</h6><p>Body paragraph with enough text.</p><pre><code>const answer = 42</code></pre><span class="katex"><span class="katex-mathml">duplicate formula text</span><span class="katex-html">x</span></span><img alt="figure"></div>'
    scroller.append(article)
    setElementMetrics(scroller, { clientHeight: 200, scrollHeight: 1_000, scrollTop: 100 })
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect(0, 10, 400, 200))
    vi.spyOn(article, 'getBoundingClientRect').mockReturnValue(rect(0, 10, 400, 1_000))
    const elements = Array.from(article.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, p, code, .katex, img'))
    elements.forEach((element, index) => {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect(0, 110 + index * 40, 300, 24))
    })

    const image = article.querySelector('img')!
    Object.defineProperties(image, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 640 },
      naturalHeight: { configurable: true, value: 320 }
    })

    const content = measureMarkdownMinimapContent(article, scroller, 60, 500)

    expect(content.headings).toHaveLength(6)
    expect(content.headings[0]).toMatchObject({ headingLevel: 1, title: 'Overview', left: 4, top: 100 })
    expect(content.headings.map((item) => item.left)).toEqual([4, 10, 16, 22, 28, 34])
    expect(content.textRuns.map((run) => run.text)).toContain('Body paragraph with enough text.')
    expect(content.textRuns.map((run) => run.text)).toContain('const answer = 42')
    expect(content.textRuns.map((run) => run.text)).not.toContain('duplicate formula text')
    expect(content.textRuns.map((run) => run.text)).not.toContain('x')
    expect(content.textRuns.some((run) => run.tone === 'body')).toBe(true)
    expect(content.textRuns.some((run) => run.tone === 'code')).toBe(true)
    expect(content.images).toHaveLength(1)
    expect(content.images[0]).toMatchObject({ element: image, sourceWidth: 640, sourceHeight: 320 })
    expect(content.formulas).toHaveLength(1)
    expect(content.formulas[0]?.element.classList.contains('katex')).toBe(true)
  })

  it('paints actual text glyphs and loaded images on a high-DPI canvas', () => {
    const canvas = document.createElement('canvas')
    const rail = document.createElement('div')
    const image = document.createElement('img')
    Object.defineProperties(image, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 200 },
      naturalHeight: { configurable: true, value: 100 }
    })
    rail.append(canvas)
    paintMarkdownMinimap(canvas, {
      textRuns: [{
        id: 'text-1', text: 'Complete paragraph text', left: 4, baseline: 12, width: 70,
        fontSize: 2, fontWeight: '400', fontStyle: 'normal', tone: 'body'
      }],
      headings: [],
      images: [{
        id: 'image-1', left: 5, top: 20, width: 50, height: 30,
        element: image, sourceWidth: 200, sourceHeight: 100
      }],
      formulas: []
    }, 60, 400, 2, canvasContext as unknown as CanvasRenderingContext2D)

    expect(canvas.width).toBe(120)
    expect(canvas.height).toBe(800)
    expect(canvasContext.fillText).toHaveBeenCalledWith('Complete paragraph text', 4, 12, 70)
    expect(canvasContext.drawImage).toHaveBeenCalledWith(image, 5, 22.5, 50, 25)
    expect(canvasContext.strokeRect).not.toHaveBeenCalled()
  })

  it('preserves image aspect ratios and falls back to an outline when pixels are unavailable', () => {
    expect(containRect(200, 100, { left: 5, top: 20, width: 30, height: 30 }))
      .toEqual({ left: 5, top: 27.5, width: 30, height: 15 })
    const canvas = document.createElement('canvas')
    const rail = document.createElement('div')
    const image = document.createElement('img')
    rail.append(canvas)

    paintMarkdownMinimap(canvas, {
      textRuns: [],
      headings: [],
      images: [{
        id: 'image-1', left: 5, top: 20, width: 30, height: 30,
        element: image, sourceWidth: 200, sourceHeight: 100
      }],
      formulas: []
    }, 60, 400, 1, canvasContext as unknown as CanvasRenderingContext2D)

    expect(canvasContext.drawImage).not.toHaveBeenCalled()
    expect(canvasContext.strokeRect).toHaveBeenCalledWith(5, 27.5, 30, 15)
  })

  it('clones each rendered KaTeX formula once into an inert visual layer', () => {
    const layer = document.createElement('div')
    const formula = document.createElement('span')
    formula.className = 'katex'
    formula.innerHTML = '<span id="unsafe-duplicate" class="katex-html">x</span>'

    renderFormulaLayer(layer, [{
      id: 'formula-1', left: 4, top: 12, width: 20, height: 4,
      element: formula, sourceWidth: 100, sourceHeight: 20,
      color: 'rgb(0, 0, 0)', fontFamily: 'KaTeX_Main', fontSize: '16px'
    }])

    expect(layer.querySelectorAll('.markdown-minimap-formula')).toHaveLength(1)
    expect(layer.querySelectorAll('.katex')).toHaveLength(1)
    expect(layer.textContent).toBe('x')
    expect(layer.querySelector('[id]')).toBeNull()
    expect((layer.firstElementChild as HTMLElement).inert).toBe(true)
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
    Object.defineProperty(rail, 'clientWidth', { configurable: true, value: 60 })
    vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 60, 400))
    const heading = view.container.querySelector('h2')!
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 200))
    vi.spyOn(heading, 'getBoundingClientRect').mockReturnValue(rect(0, 100, 300, 30))
    const scrollTo = vi.fn()
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo })

    view.rerender(<Harness revision={1} />)
    const frame = view.container.querySelector<HTMLElement>('.markdown-minimap-frame')!
    await waitFor(() => expect(view.getByRole('button', { name: '跳转到Chapter' })).toBeTruthy())
    expect(view.container.querySelector('article')?.classList.contains('markdown-minimap-measuring')).toBe(false)
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
