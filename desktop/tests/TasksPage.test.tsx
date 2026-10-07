// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentSummary } from '@shared/ipcSchemas'
import TasksPage, { documentTypeLabel, formatTaskCreatedAt } from '../src/renderer/pages/TasksPage'

afterEach(cleanup)

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })
})

describe('TasksPage', () => {
  it('shows queued as a plain badge and progress only inside the translating badge', () => {
    const running = document('paper.pdf', 'Running paper', 'translating', '2026-09-20T22:19:16')
    running.workflow.translationProgress = { totalBlocks: 1103, completedBlocks: 432, failedBlocks: 1 }
    running.workflow.progress = 67
    const queued = document('pending.pdf', 'Queued paper', 'queued', '2026-09-20T22:19:16')
    queued.workflow.progress = 25
    const completed = document('done.pdf', 'Completed paper', 'completed', '2026-09-20T22:19:16')
    completed.workflow.translationProgress = { totalBlocks: 100, completedBlocks: 100, failedBlocks: 0 }
    render(<TasksPage documents={[running, queued, completed]} onOpen={() => undefined} />)
    expect(screen.queryByText(/区块/u)).toBeNull()
    const progress = screen.getByRole('progressbar', { name: '翻译中' })
    expect(progress.getAttribute('aria-valuenow')).toBe('67')
    expect(progress.style.getPropertyValue('--task-progress')).toBe('67%')
    expect(progress.closest('td')!.querySelector('.ant-progress')).toBeNull()
    expect(screen.queryByRole('progressbar', { name: '排队中' })).toBeNull()
    expect(screen.getByText('排队中').closest('.ant-tag')).toBeTruthy()
    expect(progress.closest('td')!.classList.contains('task-progress-cell')).toBe(false)
    expect(screen.getAllByRole('progressbar')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '重试' }).getAttribute('title')).toContain('保留已完成区块')
  })

  it('shows PDF and Markdown labels and minute-precision creation times', () => {
    const documents = [
      document('paper.pdf', 'PDF paper', 'completed', '2026-09-20T22:19:16'),
      document('notes.markdown', 'Markdown notes', 'partial', '2026-09-21T08:07:59')
    ]

    const { container } = render(<TasksPage documents={documents} onOpen={() => undefined} />)

    expect(screen.getByText('PDF')).toBeTruthy()
    expect(screen.getByText('Markdown')).toBeTruthy()
    expect(screen.getByText('2026/09/20 22:19')).toBeTruthy()
    expect(screen.getByText('2026/09/21 08:07')).toBeTruthy()
    expect(screen.queryByText('2026/09/20 22:19:16')).toBeNull()

    const columnNames = ['任务名称', '状态', '类型', '创建时间', '操作']
    for (const name of columnNames) {
      const header = screen.getByRole('columnheader', { name })
      expect(header.style.textAlign).toBe('center')
    }
    expect(Array.from(container.querySelectorAll('col'), (column) => column.style.width)).toEqual(['43%', '15%', '10%', '17%', '15%'])

    const completedRow = screen.getByRole('button', { name: 'PDF paper' }).closest('tr')!
    const partialRow = screen.getByRole('button', { name: 'Markdown notes' }).closest('tr')!
    const completedSlots = completedRow.querySelector('.task-actions')!.children
    const partialSlots = partialRow.querySelector('.task-actions')!.children
    expect(completedSlots).toHaveLength(3)
    expect(completedSlots.item(0)!.getAttribute('aria-label')).toBe('打开输出目录')
    expect(completedSlots.item(1)!.classList.contains('task-action-placeholder')).toBe(true)
    expect(completedSlots.item(2)!.getAttribute('aria-label')).toBe('删除')
    expect(partialSlots).toHaveLength(3)
    expect(partialSlots.item(1)!.getAttribute('aria-label')).toBe('重试')
  })

  it('keeps legacy unknown extensions compatible with the PDF-only importer', () => {
    expect(documentTypeLabel('PAPER.MD')).toBe('Markdown')
    expect(documentTypeLabel('paper.markdown')).toBe('Markdown')
    expect(documentTypeLabel('legacy-record')).toBe('PDF')
    expect(formatTaskCreatedAt('not-a-date')).toBe('not-a-date')
  })

  it('counts tasks per status group and filters by the overview chips', () => {
    const onCreate = vi.fn()
    render(<TasksPage
      documents={[
        document('a.pdf', 'Running', 'translating', '2026-09-20T22:19:16'),
        document('b.pdf', 'Waiting', 'queued', '2026-09-20T22:19:16'),
        document('c.pdf', 'Done', 'completed', '2026-09-20T22:19:16'),
        document('d.pdf', 'Broken', 'failed', '2026-09-20T22:19:16')
      ]}
      onOpen={() => undefined}
      onCreate={onCreate}
    />)
    // Scope role queries to four chips instead of repeatedly walking Ant Design's table.
    const overview = within(screen.getByRole('group', { name: '按状态筛选' }))
    const chip = (name: RegExp): HTMLElement => overview.getByRole('button', { name })
    expect(chip(/^全部 4$/u).getAttribute('aria-pressed')).toBe('true')
    expect(chip(/^处理中 2$/u)).toBeTruthy()
    expect(chip(/^完成 1$/u)).toBeTruthy()

    fireEvent.click(chip(/^需处理 1$/u))
    expect(screen.getByText('Broken', { selector: 'button' })).toBeTruthy()
    expect(screen.queryByText('Running', { selector: 'button' })).toBeNull()

    fireEvent.click(chip(/^处理中 2$/u))
    expect(screen.getByText('Running', { selector: 'button' })).toBeTruthy()
    expect(screen.getByText('Waiting', { selector: 'button' })).toBeTruthy()
    expect(screen.queryByText('Done', { selector: 'button' })).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('请输入任务名称'), { target: { value: 'zzz' } })
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
    expect(screen.getAllByText(/^(Running|Waiting|Done|Broken)$/u, { selector: 'button' })).toHaveLength(4)
  })

  it('offers a shortcut to create the first task when the list is empty', () => {
    const onCreate = vi.fn()
    render(<TasksPage documents={[]} onOpen={() => undefined} onCreate={onCreate} />)
    fireEvent.click(screen.getByRole('button', { name: '去新解析' }))
    expect(onCreate).toHaveBeenCalled()
  })

  it('selects local file deletion by default when opening the delete dialog', () => {
    render(<TasksPage documents={[document('paper.pdf', 'Paper', 'failed', '2026-09-20T22:19:16')]} onOpen={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(screen.getByRole('checkbox', { name: '同时删除本地结果文件（不可恢复）' })).toHaveProperty('checked', true)
  })
})

function document(
  originalName: string,
  displayName: string,
  status: DocumentSummary['workflow']['status'],
  createdAt: string
): DocumentSummary {
  return {
    id: crypto.randomUUID(),
    originalName,
    displayName,
    sourceHash: `hash-${originalName}`,
    workflow: { status, progress: 100, activeJobKind: null, error: null },
    processing: { translationProvider: 'qwen' },
    createdAt,
    updatedAt: createdAt
  }
}
