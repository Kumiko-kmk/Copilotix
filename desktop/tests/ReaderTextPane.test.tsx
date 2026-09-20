// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReaderBlock } from '@shared/readerDocument'
import ReaderTextPane, { type ReaderTab } from '../src/renderer/components/ReaderTextPane'

let scrollIntoView: ReturnType<typeof vi.fn>

class ResizeObserverMock {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  scrollIntoView = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ReaderTextPane', () => {
  it('mounts only the active heavy view and restores Markdown scroll positions', async () => {
    const view = render(<Harness />)
    const originalPanel = view.container.querySelector<HTMLElement>('[data-reader-tab-panel="original"]')!
    await waitFor(() => expect(originalPanel.querySelector('.markdown-scroll')?.getAttribute('data-render-state')).toBe('ready'))
    const originalScroller = originalPanel.querySelector<HTMLElement>('.markdown-scroll')!
    originalScroller.scrollTop = 360
    fireEvent.scroll(originalScroller)
    expect(view.container.querySelector('[data-reader-tab-panel="translated"] .markdown-scroll')).toBeNull()
    expect(view.container.querySelector('[data-reader-tab-panel="json"] .json-view')).toBeNull()

    fireEvent.click(view.getByText('Markdown（中文）'))
    expect(view.container.querySelector('[data-reader-tab-panel="translated"]')?.classList.contains('active')).toBe(true)
    expect(view.container.querySelector('[data-reader-tab-panel="original"] .markdown-scroll')).toBeNull()
    await waitFor(() => expect(view.container.querySelector('[data-reader-tab-panel="translated"] .markdown-scroll')?.getAttribute('data-render-state')).toBe('ready'))

    fireEvent.click(view.getByText('JSON', { exact: true }))
    expect(view.container.querySelector('[data-reader-tab-panel="json"]')?.classList.contains('active')).toBe(true)
    expect(view.container.querySelector('[data-reader-tab-panel="translated"] .markdown-scroll')).toBeNull()
    expect(view.container.querySelector('[data-reader-tab-panel="json"] .json-view')).toBeTruthy()

    fireEvent.click(view.getByText('Markdown', { exact: true }))
    await waitFor(() => expect(view.container.querySelector('[data-reader-tab-panel="original"] .markdown-scroll')?.getAttribute('data-render-state')).toBe('ready'))
    expect(view.container.querySelector<HTMLElement>('[data-reader-tab-panel="original"] .markdown-scroll')?.scrollTop).toBe(360)
    expect(view.container.querySelector('[data-reader-tab-panel="json"] .json-view')).toBeNull()
  })

  it('accepts a completed translation without reloading or repositioning the active original pane', async () => {
    const view = render(<TranslationArrivalHarness />)
    const originalPanel = view.container.querySelector<HTMLElement>('[data-reader-tab-panel="original"]')!
    const scroller = originalPanel.querySelector<HTMLElement>('.markdown-scroll')!
    await waitFor(() => expect(scroller.getAttribute('data-render-state')).toBe('ready'))
    const article = originalPanel.querySelector('article')
    scroller.scrollTop = 360
    scrollIntoView.mockClear()

    fireEvent.click(view.getByRole('button', { name: '完成翻译' }))

    expect(scroller.getAttribute('data-render-state')).toBe('ready')
    expect(originalPanel.querySelector('article')).toBe(article)
    expect(scroller.scrollTop).toBe(360)
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-reader-tab-panel="translated"] .markdown-scroll')).toBeNull()
    expect(scroller.getAttribute('data-render-state')).toBe('ready')
    expect(scroller.scrollTop).toBe(360)
  })
})

function TranslationArrivalHarness(): React.JSX.Element {
  const [translatedReady, setTranslatedReady] = React.useState(false)
  return (
    <>
      <button onClick={() => setTranslatedReady(true)}>完成翻译</button>
      <ReaderTextPane
        tab="original"
        onTabChange={() => undefined}
        originalBlocks={[content('source', 'Source paragraph')]}
        translatedBlocks={translatedReady ? [content('source', '中文段落')] : []}
        translatedReady={translatedReady}
        taskStatus={translatedReady ? 'completed' : 'translating'}
        layoutJson='{"needle":true}'
        jsonQuery=""
        onJsonQueryChange={() => undefined}
        assetBaseUrl="copilotix-asset://task/"
        taskId="task"
        annotations={[]}
        onReplaceAnnotations={async () => undefined}
        selection={{ mappingId: 'source', origin: 'scroll' }}
        onSelect={() => undefined}
      />
    </>
  )
}

function Harness(): React.JSX.Element {
  const [tab, setTab] = React.useState<ReaderTab>('original')
  return (
    <ReaderTextPane
      tab={tab}
      onTabChange={setTab}
      originalBlocks={[content('source', 'Source paragraph')]}
      translatedBlocks={[content('source', '中文段落')]}
      translatedReady
      taskStatus="completed"
      layoutJson='{"needle":true}'
      jsonQuery=""
      onJsonQueryChange={() => undefined}
      assetBaseUrl="copilotix-asset://task/"
      taskId="task"
      annotations={[]}
      onReplaceAnnotations={async () => undefined}
      selection={null}
      onSelect={() => undefined}
    />
  )
}

function content(mappingId: string, markdown: string): ReaderBlock {
  return { role: 'content', markdown, mappingIds: [mappingId], order: 0 }
}
