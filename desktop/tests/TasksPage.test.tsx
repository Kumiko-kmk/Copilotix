// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  it('uses the status cell as progress without showing block counts or a separate bar', () => {
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
    expect(progress.closest('td')!.style.getPropertyValue('--task-progress')).toBe('67%')
    expect(progress.closest('td')!.querySelector('.ant-progress')).toBeNull()
    expect(screen.getByRole('progressbar', { name: '排队中' }).closest('td')!.style.getPropertyValue('--task-progress')).toBe('25%')
    expect(screen.getAllByRole('progressbar')).toHaveLength(2)
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
