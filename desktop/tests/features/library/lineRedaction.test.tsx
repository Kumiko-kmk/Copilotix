// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLineRedaction } from '../../../src/features/library/renderer/archive/lineRedaction'

type Report = { target: Element; contentRect: { width: number; height: number } }
let observers: Array<{ callback: (entries: Report[]) => void; targets: Element[] }> = []
const cancel = vi.fn()

beforeEach(() => {
  observers = []
  cancel.mockClear()
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => clearTimeout(frame))
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  // Like the browser, every observed element is reported once right after observe().
  vi.stubGlobal('ResizeObserver', class {
    private readonly entry: { callback: (entries: Report[]) => void; targets: Element[] }
    constructor(callback: (entries: Report[]) => void) {
      this.entry = { callback, targets: [] }
      observers.push(this.entry)
    }
    observe(target: Element): void {
      this.entry.targets.push(target)
      queueMicrotask(() => this.entry.callback([{ target, contentRect: { width: 200, height: 20 } }]))
    }
    disconnect(): void { this.entry.targets = [] }
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON: () => ({}) })
  vi.spyOn(document, 'createRange').mockImplementation(() => ({
    selectNodeContents: () => undefined,
    getClientRects: () => [{ left: 0, top: 0, right: 180, bottom: 20, width: 180, height: 20 }]
  }) as unknown as Range)
  Element.prototype.animate = vi.fn(() => ({ finished: new Promise(() => undefined), cancel }) as unknown as Animation)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(Element.prototype, 'animate')
})

function Panel(props: { reveal: boolean }): React.JSX.Element {
  const root = React.useRef<HTMLElement>(null)
  const layer = React.useRef<HTMLDivElement>(null)
  useLineRedaction(root, layer, { covered: true, reveal: props.reveal, content: null })
  return <article ref={root}><div ref={layer} /><p className="paper-archive-reveal">Covered line</p></article>
}

async function flush(ms = 50): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

describe('useLineRedaction', () => {
  it('covers the entire formula once, ignoring both visual glyph text and accessible MathML', () => {
    function FormulaPanel(): React.JSX.Element {
      const root = React.useRef<HTMLElement>(null)
      const layer = React.useRef<HTMLDivElement>(null)
      useLineRedaction(root, layer, { covered: true, reveal: false, content: null })
      return <article ref={root}><div ref={layer} /><p className="paper-archive-reveal"><span className="katex"><span className="katex-mathml">accessible</span><span className="katex-html">fraction</span></span></p></article>
    }
    const view = render(<FormulaPanel />)
    const bars = view.container.querySelectorAll<HTMLElement>('.paper-archive-redaction')
    expect(bars).toHaveLength(1)
    expect(bars[0]!.style.height).toBe('102px')
  })
  it('keeps the text unpainted while covered and paints it beneath the bars when they start to slide', async () => {
    const view = render(<Panel reveal={false} />)
    const article = view.container.querySelector('article')!
    expect(article.dataset.redacted).toBe('')
    expect(article.querySelectorAll('.paper-archive-redaction-ink')).toHaveLength(1)
    view.rerender(<Panel reveal />)
    expect(article.dataset.redacted).toBeUndefined()
    expect(Element.prototype.animate).toHaveBeenCalledTimes(1)
  })

  it('lets the bars finish their slide despite the observer reporting each element once', async () => {
    const view = render(<Panel reveal={false} />)
    await flush()
    view.rerender(<Panel reveal />)
    await flush()
    expect(cancel).not.toHaveBeenCalled()
    expect(view.container.querySelectorAll('.paper-archive-redaction-ink')).toHaveLength(1)
  })

  it('removes the bars when the layout really changes during the slide', async () => {
    const view = render(<Panel reveal={false} />)
    view.rerender(<Panel reveal />)
    await flush()
    const watcher = observers.at(-1)!
    act(() => watcher.callback([{ target: watcher.targets[0]!, contentRect: { width: 160, height: 40 } }]))
    await flush()
    expect(cancel).toHaveBeenCalled()
    expect(view.container.querySelectorAll('.paper-archive-redaction-ink')).toHaveLength(0)
  })
})
