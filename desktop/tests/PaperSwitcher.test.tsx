// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MinerUTask, TaskStatus } from '@shared/types'
import PaperSwitcher from '../src/renderer/components/PaperSwitcher'

afterEach(cleanup)

describe('PaperSwitcher', () => {
  it('renders every task in source order and opens the selected paper', () => {
    const onOpen = vi.fn()
    const tasks = [task('first', '第一篇.pdf', 'completed'), task('second', '第二篇.pdf', 'translating')]
    const view = render(<PaperSwitcher tasks={tasks} activeTaskId="second" onOpen={onOpen} />)
    const items = view.getAllByTestId('paper-switcher-item')

    expect(items).toHaveLength(2)
    expect(items.map((item) => item.textContent)).toEqual(['第一篇.pdf已完成', '第二篇.pdf翻译中 · 64%'])
    expect(items[1]!.getAttribute('aria-current')).toBe('page')
    fireEvent.click(items[0]!)
    expect(onOpen).toHaveBeenCalledWith('first')
  })

  it('shows a clear empty state', () => {
    const view = render(<PaperSwitcher tasks={[]} activeTaskId={null} onOpen={vi.fn()} />)
    expect(view.getByText('暂无论文')).toBeTruthy()
  })
})

function task(id: string, name: string, status: TaskStatus): MinerUTask {
  return {
    id,
    name,
    sourcePath: `${name}`,
    sourceHash: id,
    outputDir: '.',
    status,
    progress: status === 'translating' ? 64 : 100,
    parserModel: 'pipeline',
    translationProvider: 'qwen',
    remoteBatchId: null,
    remoteDataId: null,
    remoteResultUrl: null,
    error: null,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z'
  }
}
