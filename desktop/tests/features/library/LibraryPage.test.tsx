// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentSummary } from '@features/library/contract/documentSchemas'
import type { DetailPhase, PaperArchiveSceneOptions } from '../../../src/features/library/renderer/archive/PaperArchiveScene'
import { laneStep, paperAt, type ArchiveCell, type ArchiveShelf } from '../../../src/features/library/renderer/archive/archiveShelves'
import LibraryPage from '../../../src/features/library/renderer/LibraryPage'

const scene = vi.hoisted(() => ({
  focusPaper: vi.fn(), navigate: vi.fn(), activate: vi.fn(), dispose: vi.fn(),
  openDetail: vi.fn(), closeDetail: vi.fn(),
  enterReader: vi.fn(async (_signal: AbortSignal) => undefined), cancelReaderEntry: vi.fn(),
  phase: 'closed' as DetailPhase, onPhase: undefined as PaperArchiveSceneOptions['onDetailPhase'],
  fail: false
}))
const loader = vi.hoisted(() => ({ loadReaderPage: vi.fn(async () => ({ default: () => null })) }))
vi.mock('../../../src/features/reader/renderer/readerPageLoader', () => loader)
// Exercise the real detail markup and keyboard handlers without document/PDF I/O.
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ isPending: true }), useQueryClient: () => ({ getQueryCache: () => ({ findAll: () => [] }) }) }))
// Cover preparation has its own scene/service integration tests. Keep page navigation
// on the real saved-data gate while replacing only background PDF/IndexedDB work.
vi.mock('../../../src/features/library/renderer/archive/archiveCoverService', () => ({
  ArchiveCoverService: class {
    sync = vi.fn()
    prioritize = vi.fn()
    invalidate = vi.fn()
    peek = vi.fn(() => null)
    acquire = vi.fn()
    dispose = vi.fn()
  }
}))
vi.mock('../../../src/features/library/renderer/archive/PaperArchiveScene', () => ({
  PaperArchiveScene: class {
    private shelves: ArchiveShelf[] = []
    private cell: ArchiveCell = { lane: 0, row: 0 }
    constructor(private options: PaperArchiveSceneOptions) {
      if (scene.fail) throw new Error('WebGL unavailable')
      scene.onPhase = options.onDetailPhase
    }
    setShelves(shelves: ArchiveShelf[]): void {
      this.shelves = shelves
      this.options.onSelect({ lane: 0, row: 0 }, shelves[0]?.papers[0] ?? null)
    }
    focusPaper = scene.focusPaper
    navigate(axis: 'lane' | 'row', direction: number): void {
      scene.navigate(axis, direction)
      this.cell = axis === 'lane' ? laneStep(this.shelves, this.cell, direction, new Map())
        : { ...this.cell, row: this.cell.row + direction }
      this.options.onSelect(this.cell, paperAt(this.shelves, this.cell))
    }
    activate = scene.activate
    enterReader = scene.enterReader
    cancelReaderEntry = scene.cancelReaderEntry
    get detailOpen(): boolean { return scene.phase !== 'closed' }
    get detailReady(): boolean { return scene.phase === 'open' }
    openDetail(): void {
      const paper = paperAt(this.shelves, this.cell)
      if (!paper || this.options.canOpenDetail?.(paper) === false) return
      scene.openDetail()
      if (scene.phase === 'closed' || scene.phase === 'closing') changePhase('opening')
    }
    closeDetail(): void { scene.closeDetail(); changePhase('closing') }
    setDetailPage = vi.fn()
    dispose = scene.dispose
    setReducedMotion = vi.fn()
  }
}))

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn() })
  vi.clearAllMocks()
  loader.loadReaderPage.mockReset().mockResolvedValue({ default: () => null })
  scene.enterReader.mockReset().mockResolvedValue(undefined)
  scene.fail = false
  scene.phase = 'closed'
  localStorage.clear()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function changePhase(phase: DetailPhase): void {
  scene.phase = phase
  scene.onPhase?.(phase)
}

function region(): HTMLElement { return screen.getByRole('region', { name: '文庫' }) }

function paper(name: string, originalName = `${name}.pdf`): DocumentSummary {
  return {
    id: crypto.randomUUID(), displayName: name, originalName, sourceHash: name,
    createdAt: '2026-10-07T12:00:00Z', updatedAt: '2026-10-07T12:00:00Z',
    workflow: { status: 'completed', progress: 100, activeJobKind: null, error: null },
    processing: { translationProvider: 'qwen' }
  }
}

describe('LibraryPage', () => {
  it('blocks the archive button and Enter while background processing is incomplete', () => {
    const pending = paper('Pending')
    pending.workflow = { ...pending.workflow, status: 'translating', progress: 80 }
    render(<LibraryPage documents={[pending]} onOpen={vi.fn()} onCreate={vi.fn()} />)
    const button = screen.getByRole('button', { name: '檢視檔案' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    fireEvent.keyDown(region(), { key: 'Enter' })
    expect(scene.openDetail).not.toHaveBeenCalled()
    const progress = Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'))
    expect(progress).toBeGreaterThan(0)
    expect(progress).toBeLessThan(100)
  })

  it('shows only the selected paper’s own progress and none once a paper is complete', () => {
    const translating = (name: string, completedBlocks: number, totalBlocks: number): DocumentSummary => {
      const document = paper(name)
      document.workflow = { status: 'translating', progress: 60, activeJobKind: 'translate', error: null, translationProgress: { totalBlocks, completedBlocks, failedBlocks: 0 } }
      return document
    }
    const papers = [translating('A', 12, 80), translating('B', 55, 156), paper('Done')]
    render(<LibraryPage documents={papers} onOpen={vi.fn()} onCreate={vi.fn()} />)
    const seen = new Map<string, string[]>()
    for (let step = 0; step < papers.length; step += 1) {
      const id = document.querySelector('.paper-archive-panel')?.getAttribute('data-document-id') ?? ''
      seen.set(id, [...document.querySelectorAll('.paper-archive-status')].map((label) => label.textContent ?? ''))
      fireEvent.click(screen.getByRole('button', { name: '下一篇' }))
    }
    expect(Object.fromEntries(seen)).toEqual({
      [papers[0]!.id]: ['✓上傳→✓解析→翻譯 12/80'],
      [papers[1]!.id]: ['✓上傳→✓解析→翻譯 55/156'],
      [papers[2]!.id]: []
    })
  })
  it('searches titles and filenames without steering the archive while typing, then focuses the result', () => {
    const alpha = paper('中文論文', 'Alpha Research.pdf')
    const onOpen = vi.fn()
    render(<LibraryPage documents={[alpha, paper('Beta')]} onOpen={onOpen} onCreate={vi.fn()} />)
    const search = screen.getByRole('searchbox', { name: '搜尋文庫' })
    fireEvent.keyDown(region(), { key: '/' })
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: ' RESEARCH alpha ' } })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(scene.navigate).not.toHaveBeenCalled()
    const results = within(screen.getByRole('list', { name: '搜尋結果' }))
    expect(results.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(results.getByRole('button', { name: /中文論文/u }))
    expect(scene.focusPaper).toHaveBeenLastCalledWith(alpha.id)
    expect(onOpen).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('region', { name: '文庫' }))
    expect(screen.queryByRole('list', { name: '搜尋結果' })).toBeNull()
  })

  it('handles no matches, Escape and IME Enter without accidentally opening a paper', () => {
    render(<LibraryPage documents={[paper('Alpha')]} onOpen={vi.fn()} onCreate={vi.fn()} />)
    scene.focusPaper.mockClear()
    const search = screen.getByRole('searchbox', { name: '搜尋文庫' })
    fireEvent.focus(search)
    fireEvent.change(search, { target: { value: 'absent' } })
    expect(screen.getByText('沒有匹配的論文')).toBeTruthy()
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(scene.focusPaper).not.toHaveBeenCalled()
    fireEvent.change(search, { target: { value: 'Alpha' } })
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true })
    expect(scene.focusPaper).not.toHaveBeenCalled()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByRole('list', { name: '搜尋結果' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('region', { name: '文庫' }))
  })

  it('refreshes bounded search results when library contents change', () => {
    const documents = Array.from({ length: 45 }, (_, index) => paper(`Paper ${index}`))
    const props = { onOpen: vi.fn(), onCreate: vi.fn() }
    const view = render(<LibraryPage {...props} documents={documents} />)
    fireEvent.focus(screen.getByRole('searchbox', { name: '搜尋文庫' }))
    expect(within(screen.getByRole('list', { name: '搜尋結果' })).getAllByRole('button')).toHaveLength(40)
    expect(screen.getByText(/顯示前 40 篇/u)).toBeTruthy()
    view.rerender(<LibraryPage {...props} documents={[]} />)
    expect(screen.getByText('沒有匹配的論文')).toBeTruthy()
    expect(screen.getByRole('button', { name: '去新解析' })).toBeTruthy()
  })

  it('opens a search result after loading the reader when WebGL fails', async () => {
    scene.fail = true
    const alpha = paper('Alpha')
    const onOpen = vi.fn()
    render(<LibraryPage documents={[alpha]} onOpen={onOpen} onCreate={vi.fn()} />)
    expect(screen.getByRole('heading', { name: '當前環境無法顯示三維文庫' })).toBeTruthy()
    fireEvent.keyDown(region(), { key: '/' })
    const search = screen.getByRole('searchbox', { name: '搜尋文庫' })
    fireEvent.change(search, { target: { value: 'Alpha' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith(alpha.id))
  })

  it('shows one column for 37 uncategorised papers and loops the HUD with ArrowRight', () => {
    render(<LibraryPage documents={Array.from({ length: 37 }, (_, index) => paper(`Paper ${index}`))} onOpen={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.getByText('COLUMN 01 / 01')).toBeTruthy()
    expect(screen.getByText('關鍵詞')).toBeTruthy()
    expect(screen.getByText('總結')).toBeTruthy()
    expect(screen.queryByText('型別')).toBeNull()
    expect(screen.queryByText('建立')).toBeNull()
    expect(screen.queryByText('檔案卡')).toBeNull()
    expect(screen.queryByText('狀態')).toBeNull()
    fireEvent.keyDown(region(), { key: 'ArrowRight' })
    expect(scene.navigate).toHaveBeenCalledWith('lane', 1)
    expect(screen.getByText('COLUMN 01 / 01')).toBeTruthy()
    expect(screen.getByRole('button', { name: '下一列' })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: '流暢模式' })).toBeNull()
  })

  it('ignores held Enter and only opens the reader after detail is ready', () => {
    const onOpen = vi.fn()
    render(<LibraryPage documents={[paper('Alpha')]} onOpen={onOpen} onCreate={vi.fn()} />)
    fireEvent.keyDown(region(), { key: 'Enter', repeat: true })
    expect(scene.openDetail).not.toHaveBeenCalled()
    fireEvent.keyDown(region(), { key: 'Enter' })
    expect(scene.phase).toBe('opening')
    fireEvent.keyDown(region(), { key: 'Enter' })
    act(() => changePhase('decrypting'))
    fireEvent.keyDown(region(), { key: 'Enter' })
    expect(scene.activate).not.toHaveBeenCalled()
    // No detail entry opens a half-extracted file.
    fireEvent.click(screen.getByRole('button', { name: '開啟閱讀' }))
    expect(onOpen).not.toHaveBeenCalled()
    act(() => changePhase('open'))
    fireEvent.keyDown(region(), { key: 'Enter', repeat: true })
    expect(scene.activate).not.toHaveBeenCalled()
    fireEvent.keyDown(region(), { key: 'Enter' })
    expect(scene.activate).toHaveBeenCalledOnce()
  })

  it('cancels a pending open with Escape, ignores late loading and permits one retry', async () => {
    let loaded!: (module: { default: () => null }) => void
    loader.loadReaderPage.mockReturnValue(new Promise(resolve => { loaded = resolve }))
    const onOpen = vi.fn()
    render(<LibraryPage documents={[paper('Alpha')]} onOpen={onOpen} onCreate={vi.fn()} />)
    act(() => changePhase('open'))
    fireEvent.click(screen.getByRole('button', { name: '開啟閱讀' }))
    expect(screen.getByRole('button', { name: '正在開啟…' }).hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await act(async () => { loaded({ default: () => null }) })
    expect(onOpen).not.toHaveBeenCalled()
    expect(region().hasAttribute('data-reader-entry')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '開啟閱讀' }))
    fireEvent.keyDown(region(), { key: 'Enter', repeat: true })
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledOnce())
    expect(scene.enterReader).toHaveBeenCalledOnce()
  })

  it('leaves the archive usable after loading fails and prevents late navigation after unmount', async () => {
    const onOpen = vi.fn()
    const view = render(<LibraryPage documents={[paper('Alpha')]} onOpen={onOpen} onCreate={vi.fn()} />)
    act(() => changePhase('open'))
    loader.loadReaderPage.mockRejectedValueOnce(new Error('Offline'))
    fireEvent.click(screen.getByRole('button', { name: '開啟閱讀' }))
    expect((await screen.findByRole('alert')).textContent).toContain('閱讀器載入失敗')
    expect(onOpen).not.toHaveBeenCalled()
    let loaded!: (module: { default: () => null }) => void
    loader.loadReaderPage.mockReturnValueOnce(new Promise(resolve => { loaded = resolve }))
    fireEvent.click(screen.getByRole('button', { name: '開啟閱讀' }))
    view.unmount()
    await act(async () => { loaded({ default: () => null }) })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('scopes arrows to tabs, document scrolling or archive navigation', () => {
    render(<LibraryPage documents={[paper('Alpha')]} onOpen={vi.fn()} onCreate={vi.fn()} />)
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    expect(scene.navigate).not.toHaveBeenCalled()
    fireEvent.keyDown(region(), { key: 'Enter' })
    const abstract = screen.getByRole('tab', { name: /摘要/u })
    const structure = screen.getByRole('tab', { name: /結構/u })
    abstract.focus()
    fireEvent.keyDown(abstract, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(structure)
    expect(structure.getAttribute('aria-selected')).toBe('true')
    act(() => changePhase('open'))
    expect(document.activeElement).toBe(structure)
    fireEvent.keyDown(structure, { key: 'Home' })
    expect(document.activeElement).toBe(abstract)
    fireEvent.keyDown(abstract, { key: 'End' })
    expect(document.activeElement).toBe(structure)
    fireEvent.keyDown(structure, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(abstract)
    expect(fireEvent.keyDown(screen.getByRole('tabpanel'), { key: 'ArrowDown' })).toBe(true)
    expect(scene.navigate).not.toHaveBeenCalled()
    fireEvent.keyDown(region(), { key: 'ArrowDown' })
    expect(scene.navigate).toHaveBeenCalledWith('row', 1)
  })

  it('folds the search away while a paper is extracted and keeps the closing panel mounted but inert', () => {
    render(<LibraryPage documents={[paper('Alpha')]} onOpen={vi.fn()} onCreate={vi.fn()} />)
    fireEvent.focus(screen.getByRole('searchbox', { name: '搜尋文庫' }))
    expect(screen.getByRole('list', { name: '搜尋結果' })).toBeTruthy()
    fireEvent.keyDown(region(), { key: 'Enter' })
    expect(scene.phase).toBe('opening')
    expect(region().querySelector('.paper-archive-tools')?.hasAttribute('inert')).toBe(true)
    expect(screen.queryByRole('searchbox', { name: '搜尋文庫' })).toBeNull()
    expect(screen.queryByRole('list', { name: '搜尋結果' })).toBeNull()
    fireEvent.keyDown(region(), { key: 'Escape' })
    expect(scene.closeDetail).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(region())
    expect(region().querySelector('.paper-archive-detail-layer')?.hasAttribute('inert')).toBe(true)
    expect(region().querySelector('.paper-archive-detail')).not.toBeNull()
    fireEvent.keyDown(region(), { key: 'Enter' })
    expect(scene.phase).toBe('opening')
    expect(region().querySelector('.paper-archive-detail-layer')?.hasAttribute('inert')).toBe(false)
    act(() => changePhase('closed'))
    expect(region().querySelector('.paper-archive-detail')).toBeNull()
    expect(region().querySelector('.paper-archive-tools')?.hasAttribute('inert')).toBe(false)
    expect(screen.getByRole('searchbox', { name: '搜尋文庫' })).toBeTruthy()
  })
})
