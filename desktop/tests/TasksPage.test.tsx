// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
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
  })

  it('keeps legacy unknown extensions compatible with the PDF-only importer', () => {
    expect(documentTypeLabel('PAPER.MD')).toBe('Markdown')
    expect(documentTypeLabel('paper.markdown')).toBe('Markdown')
    expect(documentTypeLabel('legacy-record')).toBe('PDF')
    expect(formatTaskCreatedAt('not-a-date')).toBe('not-a-date')
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
