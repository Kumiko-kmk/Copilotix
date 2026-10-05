// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentSummary } from '@shared/ipcSchemas'
import CopilotixWordmark from '../src/renderer/components/CopilotixWordmark'
import { RecentShelf, greetingFor, relativeTime } from '../src/renderer/components/HomeWidgets'

afterEach(() => cleanup())

function summary(id: string, displayName: string, updatedAt: string, status: DocumentSummary['workflow']['status'] = 'completed'): DocumentSummary {
  return { id, displayName, updatedAt, workflow: { status, progress: 40 } } as unknown as DocumentSummary
}

describe('home widgets', () => {
  it('greets by time of day with the date and weekday', () => {
    expect(greetingFor(new Date(2026, 9, 5, 8, 0))).toBe('早上好 · 10月5日 星期一')
    expect(greetingFor(new Date(2026, 9, 4, 21, 0))).toBe('晚上好 · 10月4日 星期日')
    expect(greetingFor(new Date(2026, 9, 4, 2, 0))).toMatch(/^夜深了/u)
  })

  it('formats relative update times', () => {
    const now = Date.parse('2026-10-05T12:00:00Z')
    expect(relativeTime('2026-10-05T11:59:40Z', now)).toBe('刚刚')
    expect(relativeTime('2026-10-05T11:15:00Z', now)).toBe('45 分钟前')
    expect(relativeTime('2026-10-05T07:00:00Z', now)).toBe('5 小时前')
    expect(relativeTime('2026-10-03T12:00:00Z', now)).toBe('2 天前')
  })

  it('shows the three most recently updated papers and opens them', () => {
    const onOpen = vi.fn()
    const onViewAll = vi.fn()
    render(<RecentShelf
      documents={[
        summary('a', 'old.pdf', '2026-10-01T00:00:00Z'),
        summary('b', 'newest.pdf', '2026-10-05T00:00:00Z', 'translating'),
        summary('c', 'middle.pdf', '2026-10-03T00:00:00Z', 'failed'),
        summary('d', 'older.pdf', '2026-10-02T00:00:00Z')
      ]}
      onOpen={onOpen}
      onViewAll={onViewAll}
    />)
    const cards = screen.getAllByRole('button', { name: /^打开论文/u })
    expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual([
      '打开论文：newest.pdf，翻译中 · 40%',
      '打开论文：middle.pdf，失败',
      '打开论文：older.pdf，已完成'
    ])
    fireEvent.click(cards[0]!)
    expect(onOpen).toHaveBeenCalledWith('b')
    fireEvent.click(screen.getByRole('button', { name: /全部 4 篇/u }))
    expect(onViewAll).toHaveBeenCalled()
  })

  it('renders nothing without papers', () => {
    const { container } = render(<RecentShelf documents={[]} onOpen={vi.fn()} onViewAll={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })

  it('keeps the wordmark text intact after the decode animation is torn down', () => {
    const { container, unmount } = render(<CopilotixWordmark />)
    expect(screen.getByRole('img', { name: 'COPILOTIX' })).toBeTruthy()
    expect(container.querySelectorAll('.copilotix-wordmark span')).toHaveLength(10)
    fireEvent.pointerEnter(container.querySelectorAll('.copilotix-wordmark i')[4]!)
    expect(container.querySelectorAll('.copilotix-wordmark i.is-hot')).toHaveLength(10)
    expect(container.querySelectorAll('.copilotix-wordmark i.is-near')).toHaveLength(20)
    unmount()
  })
})
