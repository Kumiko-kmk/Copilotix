// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import ArchiveProgressRing from '../../../src/features/library/renderer/archive/ArchiveProgressRing'
afterEach(() => { cleanup(); vi.useRealTimers() })
it('shows success once, disappears, and stays absent after remount and renewed background work', () => {
  vi.useFakeTimers()
  const id = crypto.randomUUID()
  const view = render(<ArchiveProgressRing documentId={id} progress={82} ready={false} />)
  expect(screen.getByRole('progressbar').textContent).toBe('')
  view.rerender(<ArchiveProgressRing documentId={id} progress={100} ready />)
  expect(screen.getByRole('img', { name: '处理完成' })).toBeTruthy()
  act(() => { vi.advanceTimersByTime(1300) })
  expect(view.container.firstChild).toBeNull()
  view.unmount()
  const reopened = render(<ArchiveProgressRing documentId={id} progress={12} ready={false} />)
  expect(reopened.container.firstChild).toBeNull()
  expect(localStorage.getItem(`copilotix.archive-complete.v1:${id}`)).toBe('1')
})
it('does not hide an unfinished document on a different selection', () => {
  const view = render(<ArchiveProgressRing documentId={crypto.randomUUID()} progress={99} ready={false} />)
  expect(view.container.querySelector('[data-progress-phase="progress"]')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
})
it('reads a durable completion marker without any previous in-memory animation', () => {
  const id = crypto.randomUUID()
  localStorage.setItem(`copilotix.archive-complete.v1:${id}`, '1')
  const view = render(<ArchiveProgressRing documentId={id} progress={0} ready={false} />)
  expect(view.container.firstChild).toBeNull()
})
