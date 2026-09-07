// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentSummary } from '@shared/ipcSchemas'
import PaperSwitcher from '../src/renderer/components/PaperSwitcher'

afterEach(cleanup)

describe('PaperSwitcher', () => {
  it('renders every task in source order and opens the selected paper', () => {
    const onOpen = vi.fn()
    const documents = [document('11111111-1111-4111-8111-111111111111', '第一篇.pdf', 'completed'), document('22222222-2222-4222-8222-222222222222', '第二篇.pdf', 'translating')]
    const view = render(<PaperSwitcher documents={documents} activeDocumentId="22222222-2222-4222-8222-222222222222" onOpen={onOpen} />)
    const items = view.getAllByTestId('paper-switcher-item')

    expect(items).toHaveLength(2)
    expect(items.map((item) => item.textContent)).toEqual(['第一篇.pdf已完成', '第二篇.pdf翻译中 · 64%'])
    expect(items[1]!.getAttribute('aria-current')).toBe('page')
    fireEvent.click(items[0]!)
    expect(onOpen).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111')
  })

  it('shows a clear empty state', () => {
    const view = render(<PaperSwitcher documents={[]} activeDocumentId={null} onOpen={vi.fn()} />)
    expect(view.getByText('暂无论文')).toBeTruthy()
  })
})

function document(id: string, name: string, status: DocumentSummary['workflow']['status']): DocumentSummary {
  return {
    id,
    originalName: name,
    displayName: name,
    sourceHash: id,
    workflow: { status, progress: status === 'translating' ? 64 : 100, activeJobKind: status === 'translating' ? 'translate' : null, error: null },
    processing: { translationProvider: 'qwen' },
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z'
  }
}
