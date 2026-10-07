// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReaderBlock } from '@shared/readerDocument'
import ReaderWorkbench, { dropVerdict, dropZoneAt } from '../src/renderer/components/ReaderWorkbench'
import { useReaderViews, type ReaderChatOptions, type ReaderViewsInput } from '../src/renderer/components/ReaderViews'
import { defaultReaderLayout, normalizeLayout, type ReaderLayout } from '../src/renderer/readerLayout'
import type { PaperChatController } from '../src/renderer/usePaperChat'

vi.mock('../src/renderer/components/ReaderChatPanel', () => ({
  default: () => <section aria-label="论文 AI 问答"><textarea aria-label="问答草稿" /></section>,
  ReaderChatToolbar: () => <div>问答工具栏</div>
}))

let scrollIntoView: ReturnType<typeof vi.fn>

class ResizeObserverMock {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  scrollIntoView = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn()
    }))
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** The text views in one group, as the reader's right-hand side used to be. */
const TEXT_GROUP: ReaderLayout = normalizeLayout({
  version: 1,
  hidden: ['pdf'],
  root: { kind: 'group', id: 'g2', views: ['original', 'translated', 'chat'], active: 'original' }
})

const panel = (container: HTMLElement, view: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-reader-tab-panel="${view}"]`)

describe('ReaderWorkbench', () => {
  it('mounts only the active heavy view and restores Markdown scroll positions', async () => {
    const view = render(<Harness />)
    const originalPanel = panel(view.container, 'original')!
    await waitFor(() => expect(originalPanel.querySelector('.markdown-scroll')?.getAttribute('data-render-state')).toBe('ready'))
    const originalScroller = originalPanel.querySelector<HTMLElement>('.markdown-scroll')!
    originalScroller.scrollTop = 360
    fireEvent.scroll(originalScroller)
    expect(view.container.querySelector('[data-reader-tab-panel="translated"] .markdown-scroll')).toBeNull()

    fireEvent.click(view.getByText('Markdown（中文）'))
    expect(panel(view.container, 'translated')?.classList.contains('active')).toBe(true)
    expect(view.container.querySelector('[data-reader-tab-panel="original"] .markdown-scroll')).toBeNull()
    await waitFor(() => expect(view.container.querySelector('[data-reader-tab-panel="translated"] .markdown-scroll')?.getAttribute('data-render-state')).toBe('ready'))

    fireEvent.click(view.getByText('Markdown', { exact: true }))
    await waitFor(() => expect(view.container.querySelector('[data-reader-tab-panel="original"] .markdown-scroll')?.getAttribute('data-render-state')).toBe('ready'))
    expect(view.container.querySelector<HTMLElement>('[data-reader-tab-panel="original"] .markdown-scroll')?.scrollTop).toBe(360)
    expect(view.getByRole('tab', { name: /Markdown（中文）/u }).getAttribute('aria-selected')).toBe('false')
  })

  it('keeps chat lazy until first opened, then mounted, with its toolbar in the tab bar', async () => {
    const chat: ReaderChatOptions = {
      controller: { pinned: [{}, {}], busy: true } as unknown as PaperChatController,
      onOpenSettings: vi.fn(),
      onCitation: vi.fn()
    }
    const view = render(<Harness chat={chat} />)
    const tab = view.getByText('AI 问答')
    expect(tab.closest('.reader-chat-tab')?.querySelector('[aria-label="正在生成"]')).toBeTruthy()
    expect(tab.closest('.reader-chat-tab')?.textContent).toContain('2')
    expect(view.queryByText('问答工具栏')).toBeNull()
    const chatPanel = panel(view.container, 'chat')!
    expect(chatPanel.classList.contains('inactive')).toBe(true)
    // Opening a paper must not mount chat (and so must not trigger indexing).
    expect(view.queryByLabelText('问答草稿')).toBeNull()

    fireEvent.click(tab)
    expect(chatPanel.classList.contains('active')).toBe(true)
    expect(view.container.querySelector('.reader-group-actions')?.textContent).toContain('问答工具栏')
    expect(view.container.querySelector('[data-reader-tab-panel="original"] .markdown-scroll')).toBeNull()
    fireEvent.change(view.getByLabelText('问答草稿'), { target: { value: 'draft' } })

    fireEvent.click(view.getByText('Markdown', { exact: true }))
    await waitFor(() => expect(view.container.querySelector('[data-reader-tab-panel="original"] .markdown-scroll')).toBeTruthy())
    expect(chatPanel.classList.contains('inactive')).toBe(true)
    expect(view.queryByText('问答工具栏')).toBeNull()
    expect((view.getByLabelText('问答草稿', { selector: 'textarea' }) as HTMLTextAreaElement).value).toBe('draft')
  })

  it('accepts a completed translation without reloading or repositioning the active original pane', async () => {
    const view = render(<TranslationArrivalHarness />)
    const originalPanel = panel(view.container, 'original')!
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
  })

  it('splits a tab into a new group from its context menu and shows both views side by side', async () => {
    const onLayout = vi.fn()
    const view = render(<Harness onLayout={onLayout} />)
    fireEvent.contextMenu(view.container.querySelector('[data-reader-view="translated"]')!)
    fireEvent.click(await screen.findByText('向右拆分'))

    await waitFor(() => expect(view.container.querySelectorAll('.reader-group')).toHaveLength(2))
    // Scoped to the workbench: antd menu dividers also use role="separator".
    expect(view.container.querySelectorAll('.reader-split-handle')).toHaveLength(1)
    expect(view.container.querySelector('.reader-split-handle')?.getAttribute('aria-label')).toBe('调整 Markdown 与 Markdown（中文） 阅读器宽度')
    await waitFor(() => expect(view.container.querySelectorAll('.reader-tab-panel.active .markdown-scroll')).toHaveLength(2))
    expect(onLayout).toHaveBeenLastCalledWith(expect.objectContaining({ hidden: ['pdf'] }))
  })

  it('closes a view and reopens it from the + menu', async () => {
    const view = render(<Harness />)
    fireEvent.click(view.getByRole('button', { name: '关闭 Markdown（中文）' }))
    expect(view.queryByRole('tab', { name: /Markdown（中文）/u })).toBeNull()
    expect(panel(view.container, 'translated')).toBeNull()

    fireEvent.click(view.getByRole('button', { name: '打开已关闭的视图' }))
    fireEvent.click(await screen.findByText('Markdown（中文）'))
    await waitFor(() => expect(view.getByRole('tab', { name: /Markdown（中文）/u }).getAttribute('aria-selected')).toBe('true'))
  })

  it('never offers to close the last visible view', () => {
    const single = normalizeLayout({ version: 1, hidden: [], root: { kind: 'group', id: 'g1', views: ['original'], active: 'original' } })
    const view = render(<Harness layout={single} />)
    expect(view.queryByRole('button', { name: /^关闭 /u })).toBeNull()
  })

  it('resizes groups from the keyboard and commits the layout', () => {
    const twoGroups = normalizeLayout({
      version: 1,
      hidden: ['pdf', 'chat'],
      root: {
        kind: 'split', id: 's1', direction: 'row', sizes: [50, 50],
        children: [
          { kind: 'group', id: 'g1', views: ['original'], active: 'original' },
          { kind: 'group', id: 'g2', views: ['translated'], active: 'translated' }
        ]
      }
    })
    const onLayout = vi.fn()
    const view = render(<Harness layout={twoGroups} onLayout={onLayout} />)
    const separator = view.container.querySelector<HTMLElement>('.reader-split-handle[role="separator"]')!
    expect(separator.getAttribute('aria-valuenow')).toBe('50')
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(separator.getAttribute('aria-valuenow')).toBe('52')
    fireEvent.keyDown(separator, { key: 'End' })
    expect(separator.getAttribute('aria-valuenow')).toBe(separator.getAttribute('aria-valuemax'))
    fireEvent.doubleClick(separator)
    expect(separator.getAttribute('aria-valuenow')).toBe('50')
    expect(onLayout).toHaveBeenCalled()
  })
})

describe('tab drop targets', () => {
  const bounds = { left: 100, top: 50, width: 800, height: 600 }

  it('maps the edge quarters to splits and the middle to a merge', () => {
    expect(dropZoneAt(bounds, 500, 350)).toBe('center')
    expect(dropZoneAt(bounds, 120, 350)).toBe('left')
    expect(dropZoneAt(bounds, 880, 350)).toBe('right')
    expect(dropZoneAt(bounds, 500, 60)).toBe('top')
    expect(dropZoneAt(bounds, 500, 640)).toBe('bottom')
    expect(dropZoneAt({ left: 0, top: 0, width: 0, height: 0 }, 1, 1)).toBe('center')
  })

  it('rejects drops that would change nothing or leave a group too small', () => {
    const layout = defaultReaderLayout()
    expect(dropVerdict(layout, 'translated', 'g2', 'center')).toEqual({ allowed: false, reason: '已在此分组' })
    expect(dropVerdict(layout, 'pdf', 'g1', 'right')).toEqual({ allowed: false, reason: '已在此分组' })
    expect(dropVerdict(layout, 'translated', 'g2', 'right', bounds)).toEqual({ allowed: true })
    expect(dropVerdict(layout, 'translated', 'g2', 'right', { ...bounds, width: 400 })).toEqual({ allowed: false, reason: '空间不足' })
    expect(dropVerdict(layout, 'translated', 'g2', 'bottom', { ...bounds, height: 250 })).toEqual({ allowed: false, reason: '空间不足' })
    expect(dropVerdict(layout, 'pdf', 'g2', 'center')).toEqual({ allowed: true })
  })
})

describe('workbench keyboard shortcuts and maximize', () => {
  it('switches, closes, restores and splits views from the keyboard', async () => {
    const view = render(<Harness />)
    const selected = (): string | null => view.container.querySelector('[role="tab"][aria-selected="true"] .reader-tab-label')?.textContent ?? null

    fireEvent.keyDown(window, { key: '3', ctrlKey: true })
    expect(selected()).toBe('Markdown（中文）')
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true })
    expect(view.queryByRole('tab', { name: /Markdown（中文）/u })).toBeNull()
    fireEvent.keyDown(window, { key: 'T', ctrlKey: true, shiftKey: true })
    expect(selected()).toBe('Markdown（中文）')
    fireEvent.keyDown(window, { key: '\\', ctrlKey: true })
    await waitFor(() => expect(view.container.querySelectorAll('.reader-group')).toHaveLength(2))
    // The moved view's new group takes focus, so Ctrl+Alt+← sends it back.
    fireEvent.keyDown(window, { key: 'ArrowLeft', ctrlKey: true, altKey: true })
    await waitFor(() => expect(view.container.querySelectorAll('.reader-group')).toHaveLength(1))
  })

  it('maximizes a group on tab double-click and restores with Escape', () => {
    const twoGroups = normalizeLayout({
      version: 1,
      hidden: ['pdf', 'chat'],
      root: {
        kind: 'split', id: 's1', direction: 'row', sizes: [50, 50],
        children: [
          { kind: 'group', id: 'g1', views: ['original'], active: 'original' },
          { kind: 'group', id: 'g2', views: ['translated'], active: 'translated' }
        ]
      }
    })
    const view = render(<Harness layout={twoGroups} />)
    fireEvent.doubleClick(view.getByRole('tab', { name: /Markdown（中文）/u }))
    expect(view.container.querySelector('[data-reader-group="g2"]')?.classList.contains('maximized')).toBe(true)
    expect(view.getByRole('button', { name: '还原分组' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(view.container.querySelector('.reader-group.maximized')).toBeNull()
    // Both groups stayed mounted throughout.
    expect(view.container.querySelectorAll('.reader-group')).toHaveLength(2)
  })
})

const BASE_INPUT: Omit<ReaderViewsInput, 'chat'> = {
  originalBlocks: [content('source', 'Source paragraph')],
  translatedBlocks: [content('source', '中文段落')],
  translatedReady: true,
  taskStatus: 'completed',
  assetBaseUrl: 'copilotix-asset://task/',
  taskId: 'task',
  annotations: [],
  onReplaceAnnotations: async () => undefined,
  selection: null,
  onSelect: () => undefined
}

function Harness(props: { chat?: ReaderChatOptions; layout?: ReaderLayout; onLayout?(layout: ReaderLayout): void }): React.JSX.Element {
  return <Workbench input={{ ...BASE_INPUT, chat: props.chat }} layout={props.layout} onLayout={props.onLayout} />
}

function TranslationArrivalHarness(): React.JSX.Element {
  const [translatedReady, setTranslatedReady] = React.useState(false)
  return (
    <>
      <button onClick={() => setTranslatedReady(true)}>完成翻译</button>
      <Workbench input={{
        ...BASE_INPUT,
        translatedBlocks: translatedReady ? [content('source', '中文段落')] : [],
        translatedReady,
        taskStatus: translatedReady ? 'completed' : 'translating',
        selection: { mappingId: 'source', origin: 'scroll' }
      }} />
    </>
  )
}

function Workbench(props: { input: ReaderViewsInput; layout?: ReaderLayout; onLayout?(layout: ReaderLayout): void }): React.JSX.Element {
  const [layout, setLayout] = React.useState(props.layout ?? TEXT_GROUP)
  const [focused, setFocused] = React.useState<string | null>(null)
  const specs = useReaderViews(props.input)
  return (
    <ReaderWorkbench
      layout={layout}
      specs={specs}
      focusedGroupId={focused}
      onFocusGroup={setFocused}
      onLayoutChange={(next) => {
        setLayout(next)
        props.onLayout?.(next)
      }}
    />
  )
}

function content(mappingId: string, markdown: string): ReaderBlock {
  return { role: 'content', markdown, mappingIds: [mappingId], order: 0 }
}
