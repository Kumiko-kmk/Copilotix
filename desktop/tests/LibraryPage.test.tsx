// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentSummary } from '@shared/ipcSchemas'
import type { PaperArchiveSceneOptions } from '../src/renderer/paperArchive/PaperArchiveScene'
import type { ArchiveShelf } from '../src/renderer/paperArchive/archiveShelves'
import LibraryPage from '../src/renderer/pages/LibraryPage'

const scene = vi.hoisted(() => ({
  focusPaper: vi.fn(), navigate: vi.fn(), activate: vi.fn(), dispose: vi.fn(),
  setPerformanceMode: vi.fn(), fail: false
}))
vi.mock('../src/renderer/paperArchive/PaperArchiveScene', () => ({
  PaperArchiveScene: class {
    constructor(private options: PaperArchiveSceneOptions) {
      if (scene.fail) throw new Error('WebGL unavailable')
    }
    setShelves(shelves: ArchiveShelf[]): void {
      this.options.onSelect({ lane: 0, row: 0 }, shelves[0]?.papers[0] ?? null)
    }
    focusPaper = scene.focusPaper
    navigate = scene.navigate
    activate = scene.activate
    dispose = scene.dispose
    setPerformanceMode = scene.setPerformanceMode
    setReducedMotion = vi.fn()
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
  scene.fail = false
  localStorage.clear()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  })
})
afterEach(cleanup)

function paper(name: string, originalName = `${name}.pdf`): DocumentSummary {
  return {
    id: crypto.randomUUID(), displayName: name, originalName, sourceHash: name,
    createdAt: '2026-10-07T12:00:00Z', updatedAt: '2026-10-07T12:00:00Z',
    workflow: { status: 'completed', progress: 100, activeJobKind: null, error: null },
    processing: { translationProvider: 'qwen' }
  }
}

describe('LibraryPage', () => {
  it('searches titles and filenames without steering the archive while typing, then focuses the result', () => {
    const alpha = paper('中文论文', 'Alpha Research.pdf')
    const onOpen = vi.fn()
    render(<LibraryPage documents={[alpha, paper('Beta')]} onOpen={onOpen} onCreate={vi.fn()} />)
    const search = screen.getByRole('searchbox', { name: '搜索文库' })
    fireEvent.keyDown(window, { key: '/' })
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: ' RESEARCH alpha ' } })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(scene.navigate).not.toHaveBeenCalled()
    const results = within(screen.getByRole('list', { name: '搜索结果' }))
    expect(results.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(results.getByRole('button', { name: /中文论文/u }))
    expect(scene.focusPaper).toHaveBeenLastCalledWith(alpha.id)
    expect(onOpen).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('region', { name: '文库' }))
    expect(screen.queryByRole('list', { name: '搜索结果' })).toBeNull()
  })

  it('handles no matches, Escape and IME Enter without accidentally opening a paper', () => {
    render(<LibraryPage documents={[paper('Alpha')]} onOpen={vi.fn()} onCreate={vi.fn()} />)
    scene.focusPaper.mockClear()
    const search = screen.getByRole('searchbox', { name: '搜索文库' })
    fireEvent.focus(search)
    fireEvent.change(search, { target: { value: 'absent' } })
    expect(screen.getByText('没有匹配的论文')).toBeTruthy()
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(scene.focusPaper).not.toHaveBeenCalled()
    fireEvent.change(search, { target: { value: 'Alpha' } })
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true })
    expect(scene.focusPaper).not.toHaveBeenCalled()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByRole('list', { name: '搜索结果' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('region', { name: '文库' }))
  })

  it('refreshes bounded search results when library contents change', () => {
    const documents = Array.from({ length: 45 }, (_, index) => paper(`Paper ${index}`))
    const props = { onOpen: vi.fn(), onCreate: vi.fn() }
    const view = render(<LibraryPage {...props} documents={documents} />)
    fireEvent.focus(screen.getByRole('searchbox', { name: '搜索文库' }))
    expect(within(screen.getByRole('list', { name: '搜索结果' })).getAllByRole('button')).toHaveLength(40)
    expect(screen.getByText(/显示前 40 篇/u)).toBeTruthy()
    view.rerender(<LibraryPage {...props} documents={[]} />)
    expect(screen.getByText('没有匹配的论文')).toBeTruthy()
    expect(screen.getByRole('button', { name: '去新解析' })).toBeTruthy()
  })

  it('opens a search result directly when WebGL fails', () => {
    scene.fail = true
    const alpha = paper('Alpha')
    const onOpen = vi.fn()
    render(<LibraryPage documents={[alpha]} onOpen={onOpen} onCreate={vi.fn()} />)
    expect(screen.getByRole('heading', { name: '当前环境无法显示三维文库' })).toBeTruthy()
    fireEvent.keyDown(window, { key: '/' })
    const search = screen.getByRole('searchbox', { name: '搜索文库' })
    fireEvent.change(search, { target: { value: 'Alpha' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith(alpha.id)
    expect(screen.getByRole('checkbox', { name: '流畅模式' })).toHaveProperty('disabled', true)
  })

  it('persists quality across page mounts and changes the existing scene', () => {
    const props = { documents: [paper('Alpha')], onOpen: vi.fn(), onCreate: vi.fn() }
    const view = render(<LibraryPage {...props} />)
    fireEvent.click(screen.getByRole('checkbox', { name: '流畅模式' }))
    expect(scene.setPerformanceMode).toHaveBeenLastCalledWith(true)
    expect(scene.dispose).not.toHaveBeenCalled()
    view.unmount()
    expect(scene.dispose).toHaveBeenCalledTimes(1)
    render(<LibraryPage {...props} />)
    expect(screen.getByRole('checkbox', { name: '流畅模式' })).toHaveProperty('checked', true)
    expect(scene.setPerformanceMode).toHaveBeenLastCalledWith(true)
  })
})
