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
    <section aria-label="主頁" data-minimal={String(!props.decoration)}>
      <button type="button" onClick={() => props.onCreated(imported)}>匯入</button>
    </section>
  )
}))
vi.mock('../../src/features/reader/renderer/ReaderPage', async () => {
  const { useEffect } = await import('react')
  return { default: (props: Record<string, unknown> & { documentId: string; onOpenSettings(): void; onClose?(): void }) => {
    readerMounts.last = props
    useEffect(() => { readerMounts.count += 1 }, [])
    return <section aria-label="閱讀頁面" data-document={props.documentId}><button type="button" onClick={props.onOpenSettings}>閱讀器內去設定</button>{props.onClose ? <button type="button" onClick={props.onClose}>關閉分屏</button> : null}</section>
  } }
})

function summary(id: string, displayName: string, createdAt: string, workflow: Partial<DocumentSummary['workflow']> = {}): DocumentSummary {
  return { id, displayName, createdAt, updatedAt: createdAt, workflow: { status: 'completed', progress: 100, error: null, ...workflow } } as DocumentSummary
}

let client: QueryClient
let settings: AppSettings
let saveSettings: ReturnType<typeof vi.fn>
let openDocument: (id: string) => void
let initialDocument: string | null
let categories: Array<{ name: string; ids: string[] }> | null
let desktop: Record<string, ReturnType<typeof vi.fn>>
const papers = [
  summary('older', 'Older paper.pdf', '2026-10-01T00:00:00.000Z'),
  summary('newer', 'Newer paper.pdf', '2026-10-02T00:00:00.000Z', { status: 'translating', progress: 50, translationProgress: { completedBlocks: 3, totalBlocks: 40 } } as Partial<DocumentSummary['workflow']>)
]

beforeEach(() => {
  readerMounts.count = 0
  imported = []
  initialDocument = null
  categories = null
  desktop = {
    openDocumentWindow: vi.fn(async () => undefined),
    renameDocument: vi.fn(async () => undefined),
    deleteDocument: vi.fn(async () => undefined)
  }
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
    getUsageAnalytics: async () => ({ days: [] }), saveSettings,
    initialDocument: async () => initialDocument,
    libraryCategories: async () => {
      if (!categories) throw new Error('not classified')
      return {
        revision: '0123456789abcdef', next: null,
        categories: categories.map((category, index) => ({ id: `c-${index}`, name: category.name, named: 'terms', size: category.ids.length })),
        items: categories.flatMap((category, index) => category.ids.map((documentId, rank) => ({ documentId, category: index, rank })))
      }
    },
    ...desktop
  } })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } })
  client.setQueryData(['settings'], settings)
  client.setQueryData(['documents'], { revision: 0, documents: papers })
})
afterEach(() => { cleanup(); client.clear(); window.localStorage.clear(); vi.restoreAllMocks() })

function renderApp(): void {
  render(<QueryClientProvider client={client}><ConfigProvider theme={{ token: { motion: false } }}><LiteApp /></ConfigProvider></QueryClientProvider>)
}
const sidebar = () => within(screen.getByRole('navigation', { name: '論文導覽' }))
const paperButton = (name: RegExp) => sidebar().getByRole('button', { name })
const dialogButton = (name: string) => within(screen.getByRole('dialog', { name: '有未儲存的設定' })).getByRole('button', { name })

it('starts on a plain home page with no top navigation, tutorial or library', () => {
  renderApp()
  expect(screen.getByRole('region', { name: '主頁' }).getAttribute('data-minimal')).toBe('true')
  expect(screen.queryByRole('navigation', { name: '主導覽' })).toBeNull()
  expect(screen.queryByText('文庫')).toBeNull()
  expect(sidebar().getByRole('button', { name: '新建' }).getAttribute('aria-current')).toBe('page')
})

it('lists the newest import first and reports progress only for unfinished papers', () => {
  renderApp()
  const rows = sidebar().getAllByRole('listitem').map((row) => row.textContent)
  expect(rows).toEqual(['Newer paper翻譯中 3/40', 'Older paper'])
})

it('switches papers in one click, without a back button, and returns home from 新建', async () => {
  renderApp()
  fireEvent.click(paperButton(/Older paper/u))
  expect((await screen.findByRole('region', { name: '閱讀頁面' })).getAttribute('data-document')).toBe('older')
  expect(readerMounts.last.showBack).toBe(false)
  expect(readerMounts.last.resumePosition).toBe(true)
  // No archive card entry: the source of it is never handed to the reader.
  expect(readerMounts.last.insights).toBeUndefined()
  expect(paperButton(/Older paper/u).getAttribute('aria-current')).toBe('page')

  fireEvent.click(paperButton(/Newer paper/u))
  // The paper left stays mounted (hidden and inert), so going back to it is immediate.
  await waitFor(() => expect(document.querySelector('.lite-reader-slot[data-active] section')?.getAttribute('data-document')).toBe('newer'))
  expect(document.querySelector('.lite-reader-slot:not([data-active])')?.hasAttribute('inert')).toBe(true)

  fireEvent.click(sidebar().getByRole('button', { name: '新建' }))
  expect(screen.getByRole('region', { name: '主頁' })).toBeTruthy()
  // Both readers stay mounted for a quick return, but neither is shown.
  expect(document.querySelector('.lite-reader-slot[data-active]')).toBeNull()
})

it('opens a single imported paper at once, but stays home after a batch', async () => {
  imported = [summary('a', 'A.pdf', '2026-10-03T00:00:00.000Z'), summary('b', 'B.pdf', '2026-10-03T00:00:01.000Z')]
  renderApp()
  fireEvent.click(screen.getByRole('button', { name: '匯入' }))
  expect(screen.getByRole('region', { name: '主頁' })).toBeTruthy()
  imported = [summary('c', 'C.pdf', '2026-10-04T00:00:00.000Z')]
  fireEvent.click(screen.getByRole('button', { name: '匯入' }))
  expect((await screen.findByRole('region', { name: '閱讀頁面' })).getAttribute('data-document')).toBe('c')
})

it('opens settings in a window over the open paper and returns to it without remounting the reader', async () => {
  renderApp()
  fireEvent.click(paperButton(/Older paper/u))
  await screen.findByRole('region', { name: '閱讀頁面' })
  fireEvent.click(screen.getByRole('button', { name: '設定' }))
  const nav = within(await screen.findByRole('navigation', { name: '設定分類' }))
  expect(nav.getAllByRole('button').map((button) => button.textContent)).toEqual(['服務', '儲存', '外觀'])
  // The covered page cannot be reached with Tab or a click.
  expect(document.querySelector('.lite-body')?.hasAttribute('inert')).toBe(true)
  // Only what needs attention: no usage charts, no save bar until something changed.
  expect(document.querySelector('.settings-page.is-window')).toBeTruthy()
  expect(document.querySelector('.usage-dashboard')).toBeNull()
  expect(screen.queryByText('所有更改均已儲存')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '關閉設定' }))
  await waitFor(() => expect(screen.queryByRole('navigation', { name: '設定分類' })).toBeNull())
  expect(screen.getByRole('region', { name: '閱讀頁面' }).getAttribute('data-document')).toBe('older')
  expect(readerMounts.count).toBe(1)

  // Esc closes the window too.
  fireEvent.click(screen.getByRole('button', { name: '設定' }))
  const window = await screen.findByRole('navigation', { name: '設定分類' })
  fireEvent.keyDown(window, { key: 'Escape', keyCode: 27 })
  await waitFor(() => expect(screen.queryByRole('navigation', { name: '設定分類' })).toBeNull())
  expect(readerMounts.count).toBe(1)
})

it('keeps the unsaved-settings guard when going back or when the OS opens a paper', async () => {
  renderApp()
  fireEvent.click(screen.getByRole('button', { name: '設定' }))
  await screen.findByRole('navigation', { name: '設定分類' })
  // The services page opens first; its row switch changes which models translate.
  fireEvent.click(screen.getByRole('switch', { name: '用千問翻譯' }))

  fireEvent.click(screen.getByRole('button', { name: '關閉設定' }))
  fireEvent.click(dialogButton('繼續編輯'))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '有未儲存的設定' })).toBeNull())
  expect(screen.getByText('有未儲存的更改')).toBeTruthy()

  act(() => openDocument('older'))
  fireEvent.click(dialogButton('放棄並離開'))
  expect((await screen.findByRole('region', { name: '閱讀頁面' })).getAttribute('data-document')).toBe('older')
  expect(saveSettings).not.toHaveBeenCalled()
})

it('collapses the sidebar with its button or Ctrl+B, except while typing, and remembers it', () => {
  renderApp()
  fireEvent.click(screen.getByRole('button', { name: '收起側邊欄' }))
  expect(screen.queryByRole('navigation', { name: '論文導覽' })).toBeNull()
  expect(window.localStorage.getItem('copilotix.lite.sidebar-collapsed.v1')).toBe('1')

  fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
  expect(screen.getByRole('navigation', { name: '論文導覽' })).toBeTruthy()

  const input = document.body.appendChild(document.createElement('input'))
  fireEvent.keyDown(input, { key: 'b', ctrlKey: true })
  input.remove()
  expect(screen.getByRole('navigation', { name: '論文導覽' })).toBeTruthy()

  cleanup()
  window.localStorage.setItem('copilotix.lite.sidebar-collapsed.v1', '1')
  renderApp()
  expect(screen.queryByRole('navigation', { name: '論文導覽' })).toBeNull()
})

const openMenu = (name: RegExp) => fireEvent.contextMenu(paperButton(name))
const menuItem = async (name: string) => within(await screen.findByRole('menu')).getByRole('menuitem', { name })

it('groups papers by content under folding headings, with global and in-group pins', async () => {
  const third = summary('third', 'Third paper.pdf', '2026-10-03T00:00:00.000Z')
  client.setQueryData(['documents'], { revision: 0, documents: [...papers, third] })
  categories = [{ name: '斷裂力學', ids: ['older', 'third'] }, { name: '材料', ids: ['newer'] }]
  renderApp()
  await waitFor(() => expect(sidebar().getByRole('button', { name: '斷裂力學' })).toBeTruthy(), { timeout: 5000 })
  const group = (name: string) => sidebar().getByRole('list', { name }).textContent
  expect(group('斷裂力學')).toBe('Third paperOlder paper')

  openMenu(/Older paper/u)
  fireEvent.click(await menuItem('在分組內置頂'))
  await waitFor(() => expect(group('斷裂力學')).toBe('Older paperThird paper'))

  openMenu(/Newer paper/u)
  fireEvent.click(await menuItem('置頂'))
  await waitFor(() => expect(group('置頂')).toBe('Newer paper翻譯中 3/40'))
  // Its only paper pinned, the 材料 section goes away.
  expect(sidebar().queryByRole('button', { name: '材料' })).toBeNull()

  fireEvent.click(sidebar().getByRole('button', { name: '斷裂力學' }))
  expect(sidebar().queryByRole('list', { name: '斷裂力學' })).toBeNull()
  expect(sidebar().getByRole('button', { name: '斷裂力學' }).getAttribute('aria-expanded')).toBe('false')
  // Pins and folds survive a restart of the window.
  cleanup()
  renderApp()
  await waitFor(() => expect(sidebar().getByRole('list', { name: '置頂' }).textContent).toContain('Newer paper'))
  await waitFor(() => expect(sidebar().getByRole('button', { name: '斷裂力學' }).getAttribute('aria-expanded')).toBe('false'), { timeout: 5000 })
})

it('renames a paper in place from its menu, and Escape keeps the old title', async () => {
  renderApp()
  openMenu(/Older paper/u)
  fireEvent.click(await menuItem('重新命名'))
  const field = await sidebar().findByRole('textbox', { name: '論文標題' })
  expect((field as HTMLInputElement).value).toBe('Older paper')
  fireEvent.change(field, { target: { value: '  A clearer title ' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  await waitFor(() => expect(desktop.renameDocument).toHaveBeenCalledWith({ documentId: 'older', title: 'A clearer title' }))

  fireEvent.keyDown(paperButton(/Newer paper/u), { key: 'F2' })
  const second = await sidebar().findByRole('textbox', { name: '論文標題' })
  fireEvent.change(second, { target: { value: 'Discarded' } })
  fireEvent.keyDown(second, { key: 'Escape' })
  await waitFor(() => expect(sidebar().queryByRole('textbox')).toBeNull())
  expect(desktop.renameDocument).toHaveBeenCalledTimes(1)
})

it('opens a paper in a new window, and a window opened for a paper starts on it', async () => {
  renderApp()
  openMenu(/Newer paper/u)
  fireEvent.click(await menuItem('在新視窗中開啟'))
  expect(desktop.openDocumentWindow).toHaveBeenCalledWith('newer')
  cleanup()
  initialDocument = 'older'
  renderApp()
  expect((await screen.findByRole('region', { name: '閱讀頁面' })).getAttribute('data-document')).toBe('older')
})

it('shows a second paper beside the open one; the sidebar fills the pane used last', async () => {
  renderApp()
  fireEvent.click(paperButton(/Older paper/u))
  await screen.findByRole('region', { name: '閱讀頁面' })
  openMenu(/Older paper/u)
  expect((await menuItem('分屏開啟')).getAttribute('aria-disabled')).toBe('true')
  openMenu(/Newer paper/u)
  fireEvent.click(await menuItem('分屏開啟'))
  await waitFor(() => expect(screen.getAllByRole('region', { name: '閱讀頁面' }).map((reader) => reader.getAttribute('data-document'))).toEqual(['older', 'newer']))
  const handle = () => screen.getByRole('separator', { name: '調整分屏寬度' })
  expect(handle().getAttribute('aria-valuenow')).toBe('50')
  fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
  expect(handle().getAttribute('aria-valuenow')).toBe('45')
  // The split pane was used last: the highlighted paper is the one there.
  expect(paperButton(/Newer paper/u).getAttribute('aria-current')).toBe('page')

  fireEvent.pointerDown(screen.getAllByRole('region', { name: '閱讀頁面' })[0]!)
  expect(paperButton(/Older paper/u).getAttribute('aria-current')).toBe('page')
  fireEvent.click(screen.getByRole('button', { name: '關閉分屏' }))
  await waitFor(() => expect(screen.getAllByRole('region', { name: '閱讀頁面' })).toHaveLength(1))
  expect(screen.queryByRole('separator')).toBeNull()
})

it('deletes a paper from its menu after confirmation and leaves its reader', async () => {
  renderApp()
  fireEvent.click(paperButton(/Older paper/u))
  await screen.findByRole('region', { name: '閱讀頁面' })
  openMenu(/Older paper/u)
  fireEvent.click(await menuItem('刪除'))
  const dialog = within(await screen.findByRole('dialog', { name: '刪除論文' }))
  fireEvent.click(dialog.getByRole('button', { name: /刪\s*除/u }))
  await waitFor(() => expect(desktop.deleteDocument).toHaveBeenCalledWith({ documentId: 'older', deleteFiles: true }))
  await waitFor(() => expect(screen.getByRole('region', { name: '主頁' })).toBeTruthy())
})
