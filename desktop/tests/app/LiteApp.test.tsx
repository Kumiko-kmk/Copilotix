// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfigProvider } from 'antd'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@features/settings/contract/defaultSettings'
import type { DocumentSummary } from '@features/library/contract/documentSchemas'
import type { AppSettings, SettingsUpdate } from '@features/settings/contract/settingsTypes'
import LiteApp from '../../src/app/renderer/LiteApp'

const readerMounts = vi.hoisted(() => ({ count: 0, last: {} as Record<string, unknown> }))
let imported: DocumentSummary[] = []

vi.mock('../../src/app/renderer/WindowControls', () => ({ default: () => null }))
vi.mock('../../src/features/library/renderer/NewParsePage', () => ({
  default: (props: { decoration?: unknown; onCreated(created: DocumentSummary[]): void }) => (
    <section aria-label="主页" data-minimal={String(!props.decoration)}>
      <button type="button" onClick={() => props.onCreated(imported)}>导入</button>
    </section>
  )
}))
vi.mock('../../src/features/reader/renderer/ReaderPage', async () => {
  const { useEffect } = await import('react')
  return { default: (props: Record<string, unknown> & { documentId: string; onOpenSettings(): void }) => {
    readerMounts.last = props
    useEffect(() => { readerMounts.count += 1 }, [])
    return <section aria-label="阅读页面" data-document={props.documentId}><button type="button" onClick={props.onOpenSettings}>阅读器内去设置</button></section>
  } }
})

function summary(id: string, displayName: string, createdAt: string, workflow: Partial<DocumentSummary['workflow']> = {}): DocumentSummary {
  return { id, displayName, createdAt, updatedAt: createdAt, workflow: { status: 'completed', progress: 100, error: null, ...workflow } } as DocumentSummary
}

let client: QueryClient
let settings: AppSettings
let saveSettings: ReturnType<typeof vi.fn>
let openDocument: (id: string) => void
const papers = [
  summary('older', 'Older paper.pdf', '2026-10-01T00:00:00.000Z'),
  summary('newer', 'Newer paper.pdf', '2026-10-02T00:00:00.000Z', { status: 'translating', progress: 50, translationProgress: { completedBlocks: 3, totalBlocks: 40 } } as Partial<DocumentSummary['workflow']>)
]

beforeEach(() => {
  readerMounts.count = 0
  imported = []
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })) })
  settings = structuredClone(DEFAULT_SETTINGS)
  saveSettings = vi.fn(async (update: SettingsUpdate) => {
    const { credentialMutations: _mutations, ...publicSettings } = update
    settings = { ...publicSettings, credentials: settings.credentials }
    return { settings, fieldErrors: {} }
  })
  Object.defineProperty(window, 'copilotix', { configurable: true, value: {
    getSettings: async () => settings, listDocuments: async () => papers,
    onDocumentsChanged: () => () => undefined,
    onOpenDocument: (listener: typeof openDocument) => { openDocument = listener; return () => undefined },
    getUsageAnalytics: async () => ({ days: [] }), saveSettings
  } })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } })
  client.setQueryData(['settings'], settings)
  client.setQueryData(['documents'], { revision: 0, documents: papers })
})
afterEach(() => { cleanup(); client.clear(); window.localStorage.clear(); vi.restoreAllMocks() })

function renderApp(): void {
  render(<QueryClientProvider client={client}><ConfigProvider theme={{ token: { motion: false } }}><LiteApp /></ConfigProvider></QueryClientProvider>)
}
const sidebar = () => within(screen.getByRole('navigation', { name: '论文导航' }))
const paperButton = (name: RegExp) => sidebar().getByRole('button', { name })
const dialogButton = (name: string) => within(screen.getByRole('dialog', { name: '有未保存的设置' })).getByRole('button', { name })

it('starts on a plain home page with no top navigation, tutorial or library', () => {
  renderApp()
  expect(screen.getByRole('region', { name: '主页' }).getAttribute('data-minimal')).toBe('true')
  expect(screen.queryByRole('navigation', { name: '主导航' })).toBeNull()
  expect(screen.queryByText('文库')).toBeNull()
  expect(sidebar().getByRole('button', { name: '新建' }).getAttribute('aria-current')).toBe('page')
})

it('lists the newest import first and reports progress only for unfinished papers', () => {
  renderApp()
  const rows = sidebar().getAllByRole('listitem').map((row) => row.textContent)
  expect(rows).toEqual(['Newer paper翻译中 3/40', 'Older paper'])
})

it('switches papers in one click, without a back button, and returns home from 新建', async () => {
  renderApp()
  fireEvent.click(paperButton(/Older paper/u))
  expect((await screen.findByRole('region', { name: '阅读页面' })).getAttribute('data-document')).toBe('older')
  expect(readerMounts.last.showBack).toBe(false)
  expect(readerMounts.last.resumePosition).toBe(true)
  // No archive card entry: the source of it is never handed to the reader.
  expect(readerMounts.last.insights).toBeUndefined()
  expect(paperButton(/Older paper/u).getAttribute('aria-current')).toBe('page')

  fireEvent.click(paperButton(/Newer paper/u))
  await waitFor(() => expect(screen.getByRole('region', { name: '阅读页面' }).getAttribute('data-document')).toBe('newer'))

  fireEvent.click(sidebar().getByRole('button', { name: '新建' }))
  expect(screen.getByRole('region', { name: '主页' })).toBeTruthy()
  expect(screen.queryByRole('region', { name: '阅读页面' })).toBeNull()
})

it('opens a single imported paper at once, but stays home after a batch', async () => {
  imported = [summary('a', 'A.pdf', '2026-10-03T00:00:00.000Z'), summary('b', 'B.pdf', '2026-10-03T00:00:01.000Z')]
  renderApp()
  fireEvent.click(screen.getByRole('button', { name: '导入' }))
  expect(screen.getByRole('region', { name: '主页' })).toBeTruthy()
  imported = [summary('c', 'C.pdf', '2026-10-04T00:00:00.000Z')]
  fireEvent.click(screen.getByRole('button', { name: '导入' }))
  expect((await screen.findByRole('region', { name: '阅读页面' })).getAttribute('data-document')).toBe('c')
})

it('opens settings in a window over the open paper and returns to it without remounting the reader', async () => {
  renderApp()
  fireEvent.click(paperButton(/Older paper/u))
  await screen.findByRole('region', { name: '阅读页面' })
  fireEvent.click(screen.getByRole('button', { name: '设置' }))
  const nav = within(screen.getByRole('navigation', { name: '设置分类' }))
  expect(nav.getByRole('button', { name: /模型设置/u })).toBeTruthy()
  // The covered page cannot be reached with Tab or a click.
  expect(document.querySelector('.lite-body')?.hasAttribute('inert')).toBe(true)
  // Only what needs attention: no usage charts, no save bar until something changed.
  expect(document.querySelector('.settings-page.is-window')).toBeTruthy()
  expect(document.querySelector('.usage-dashboard')).toBeNull()
  expect(screen.queryByText('所有更改均已保存')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
  await waitFor(() => expect(screen.queryByRole('navigation', { name: '设置分类' })).toBeNull())
  expect(screen.getByRole('region', { name: '阅读页面' }).getAttribute('data-document')).toBe('older')
  expect(readerMounts.count).toBe(1)

  // Esc closes the window too.
  fireEvent.click(screen.getByRole('button', { name: '设置' }))
  const window = await screen.findByRole('navigation', { name: '设置分类' })
  fireEvent.keyDown(window, { key: 'Escape', keyCode: 27 })
  await waitFor(() => expect(screen.queryByRole('navigation', { name: '设置分类' })).toBeNull())
  expect(readerMounts.count).toBe(1)
})

it('keeps the unsaved-settings guard when going back or when the OS opens a paper', async () => {
  renderApp()
  fireEvent.click(screen.getByRole('button', { name: '设置' }))
  const nav = within(screen.getByRole('navigation', { name: '设置分类' }))
  fireEvent.click(nav.getByRole('button', { name: /模型设置/u }))
  fireEvent.click(screen.getByLabelText('启用千问 / Qwen'))

  fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
  fireEvent.click(dialogButton('继续编辑'))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '有未保存的设置' })).toBeNull())
  expect(screen.getByText('有未保存的更改')).toBeTruthy()

  act(() => openDocument('older'))
  fireEvent.click(dialogButton('放弃并离开'))
  expect((await screen.findByRole('region', { name: '阅读页面' })).getAttribute('data-document')).toBe('older')
  expect(saveSettings).not.toHaveBeenCalled()
})

it('collapses the sidebar with its button or Ctrl+B, except while typing, and remembers it', () => {
  renderApp()
  fireEvent.click(screen.getByRole('button', { name: '收起侧边栏' }))
  expect(screen.queryByRole('navigation', { name: '论文导航' })).toBeNull()
  expect(window.localStorage.getItem('copilotix.lite.sidebar-collapsed.v1')).toBe('1')

  fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
  expect(screen.getByRole('navigation', { name: '论文导航' })).toBeTruthy()

  const input = document.body.appendChild(document.createElement('input'))
  fireEvent.keyDown(input, { key: 'b', ctrlKey: true })
  input.remove()
  expect(screen.getByRole('navigation', { name: '论文导航' })).toBeTruthy()

  cleanup()
  window.localStorage.setItem('copilotix.lite.sidebar-collapsed.v1', '1')
  renderApp()
  expect(screen.queryByRole('navigation', { name: '论文导航' })).toBeNull()
})
