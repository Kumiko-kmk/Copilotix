// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EdgeDock from '../src/renderer/components/EdgeDock'

describe('EdgeDock', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('opens on pointer entry and closes 250ms after pointer exit', () => {
    const view = render(<EdgeDock edge="bottom" label="展开论文切换"><button>论文</button></EdgeDock>)
    const dock = view.container.querySelector<HTMLElement>('[data-edge-dock="bottom"]')!
    const panel = dock.querySelector<HTMLElement>('.edge-dock-panel')!

    expect(panel.getAttribute('aria-hidden')).toBe('true')
    fireEvent.pointerEnter(dock)
    expect(panel.getAttribute('aria-hidden')).toBe('false')

    fireEvent.pointerLeave(dock)
    act(() => vi.advanceTimersByTime(249))
    expect(panel.getAttribute('aria-hidden')).toBe('false')
    act(() => vi.advanceTimersByTime(1))
    expect(panel.getAttribute('aria-hidden')).toBe('true')
  })

  it('opens for keyboard focus and closes with Escape', () => {
    const view = render(<EdgeDock edge="top" label="展开主导航"><button>新解析</button></EdgeDock>)
    const dock = view.container.querySelector<HTMLElement>('[data-edge-dock="top"]')!
    const trigger = view.getByRole('button', { name: '展开主导航' })
    const panel = dock.querySelector<HTMLElement>('.edge-dock-panel')!

    fireEvent.focus(trigger)
    expect(panel.getAttribute('aria-hidden')).toBe('false')
    fireEvent.keyDown(dock, { key: 'Escape' })
    expect(panel.getAttribute('aria-hidden')).toBe('true')
    expect(document.activeElement).toBe(trigger)
  })
})
