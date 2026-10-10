// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentSummary } from '@shared/ipcSchemas'
import DocumentLifecycleActions from '../src/renderer/components/DocumentLifecycleActions'

afterEach(cleanup)

const retryDocument = vi.fn(async () => undefined)
const deleteDocument = vi.fn(async () => undefined)

beforeEach(() => {
  retryDocument.mockClear()
  deleteDocument.mockClear()
  Object.defineProperty(window, 'copilotix', { configurable: true, value: { retryDocument, deleteDocument } })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn()
    }))
  })
})

function messageApi() {
  return { success: vi.fn(), error: vi.fn() } as unknown as Parameters<typeof DocumentLifecycleActions>[0]['messageApi']
}

describe('DocumentLifecycleActions', () => {
  it('offers retry only for failed, partial and translating papers, without hover titles', () => {
    for (const status of ['failed', 'partial', 'translating'] as const) {
      const { unmount } = render(<DocumentLifecycleActions summary={summary(status)} messageApi={messageApi()} onDeleted={vi.fn()} />)
      expect(screen.getByRole('button', { name: '重试' }).getAttribute('title')).toBeNull()
      unmount()
    }
    for (const status of ['queued', 'parsing', 'completed'] as const) {
      const { unmount } = render(<DocumentLifecycleActions summary={summary(status)} messageApi={messageApi()} onDeleted={vi.fn()} />)
      expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
      unmount()
    }
  })

  it('queues a retry for the paper', async () => {
    render(<DocumentLifecycleActions summary={summary('failed')} messageApi={messageApi()} onDeleted={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(retryDocument).toHaveBeenCalledWith('paper-id'))
  })

  it('deletes after confirmation, removing local files by default, then leaves the reader', async () => {
    const onDeleted = vi.fn()
    render(<DocumentLifecycleActions summary={summary('completed')} messageApi={messageApi()} onDeleted={onDeleted} />)
    fireEvent.click(screen.getByRole('button', { name: '删除论文' }))
    expect(screen.getByRole('checkbox', { name: '同时删除本地结果文件（不可恢复）' })).toHaveProperty('checked', true)
    expect(deleteDocument).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(deleteDocument).toHaveBeenCalledWith({ documentId: 'paper-id', deleteFiles: true })
  })

  it('can keep local files and stays in the reader when deletion fails', async () => {
    deleteDocument.mockRejectedValueOnce(new Error('busy'))
    const onDeleted = vi.fn()
    const api = messageApi()
    render(<DocumentLifecycleActions summary={summary('completed')} messageApi={api} onDeleted={onDeleted} />)
    fireEvent.click(screen.getByRole('button', { name: '删除论文' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '同时删除本地结果文件（不可恢复）' }))
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(api.error).toHaveBeenCalledWith('busy'))
    expect(deleteDocument).toHaveBeenCalledWith({ documentId: 'paper-id', deleteFiles: false })
    expect(onDeleted).not.toHaveBeenCalled()
  })
})

function summary(status: DocumentSummary['workflow']['status']): DocumentSummary {
  return {
    id: 'paper-id',
    originalName: 'paper.pdf',
    displayName: 'Paper',
    sourceHash: 'hash',
    workflow: { status, progress: 40, activeJobKind: null, error: null },
    processing: { translationProvider: 'qwen' },
    createdAt: '2026-10-10T08:00:00Z',
    updatedAt: '2026-10-10T08:00:00Z'
  }
}
