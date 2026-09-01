// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReaderBlock } from '@shared/readerDocument'
import ReaderTextPane, { type ReaderTab } from '../src/renderer/components/ReaderTextPane'

class ResizeObserverMock {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ReaderTextPane', () => {
  it('prewarms secondary views and preserves their DOM across repeated tab switches', async () => {
    const view = render(<Harness />)
    const originalPanel = view.container.querySelector<HTMLElement>('[data-reader-tab-panel="original"]')!
    await waitFor(() => expect(originalPanel.querySelector('.markdown-scroll')?.getAttribute('data-render-state')).toBe('ready'))
    const originalScroller = originalPanel.querySelector('.markdown-scroll')

    await waitFor(() => {
      expect(view.container.querySelector('[data-reader-tab-panel="translated"] .markdown-scroll')).toBeTruthy()
      expect(view.container.querySelector('[data-reader-tab-panel="json"] .json-view')).toBeTruthy()
    })
    const translatedScroller = view.container.querySelector('[data-reader-tab-panel="translated"] .markdown-scroll')
    const jsonView = view.container.querySelector('[data-reader-tab-panel="json"] .json-view')

    fireEvent.click(view.getByText('Markdown（中文）'))
    expect(view.container.querySelector('[data-reader-tab-panel="translated"]')?.classList.contains('active')).toBe(true)
    expect(view.container.querySelector('[data-reader-tab-panel="original"] .markdown-scroll')).toBe(originalScroller)

    fireEvent.click(view.getByText('JSON', { exact: true }))
    expect(view.container.querySelector('[data-reader-tab-panel="json"]')?.classList.contains('active')).toBe(true)
    expect(view.container.querySelector('[data-reader-tab-panel="translated"] .markdown-scroll')).toBe(translatedScroller)

    fireEvent.click(view.getByText('Markdown', { exact: true }))
    expect(view.container.querySelector('[data-reader-tab-panel="original"] .markdown-scroll')).toBe(originalScroller)
    expect(view.container.querySelector('[data-reader-tab-panel="json"] .json-view')).toBe(jsonView)
  })
})

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
      assetBaseUrl="mineru-asset://task/"
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
