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

  it('keeps the panel open when a hover-opened trigger is clicked', () => {
    const view = render(<EdgeDock edge="bottom" label="展开论文切换"><button>论文</button></EdgeDock>)
    const dock = view.container.querySelector<HTMLElement>('[data-edge-dock="bottom"]')!
    const trigger = view.getByRole('button', { name: '展开论文切换' })
    const panel = dock.querySelector<HTMLElement>('.edge-dock-panel')!

    fireEvent.pointerEnter(dock)
    fireEvent.click(trigger)
    expect(panel.getAttribute('aria-hidden')).toBe('false')
  })

  it('keeps an open panel alive when the pointer enters its floating content', () => {
    const view = render(<EdgeDock edge="bottom" label="展开论文切换"><button>论文</button></EdgeDock>)
    const dock = view.container.querySelector<HTMLElement>('[data-edge-dock="bottom"]')!
    const panel = dock.querySelector<HTMLElement>('.edge-dock-panel')!

    fireEvent.pointerEnter(dock)
    fireEvent.pointerLeave(dock)
    fireEvent.pointerEnter(panel)
    act(() => vi.advanceTimersByTime(300))
    expect(panel.getAttribute('aria-hidden')).toBe('false')
  })

  it('does not schedule a hide when leaving the dock into its panel', () => {
    const view = render(<EdgeDock edge="bottom" label="展开论文切换"><button>论文</button></EdgeDock>)
    const dock = view.container.querySelector<HTMLElement>('[data-edge-dock="bottom"]')!
    const panel = dock.querySelector<HTMLElement>('.edge-dock-panel')!

    fireEvent.pointerEnter(dock)
    fireEvent.pointerLeave(dock, { relatedTarget: panel })
    act(() => vi.advanceTimersByTime(300))
    expect(panel.getAttribute('aria-hidden')).toBe('false')
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

  it('never renders a top grab bar over the persistent project name', () => {
    const top = render(<EdgeDock edge="top" label="展开主导航"><button>新解析</button></EdgeDock>)
    expect(top.getByRole('button', { name: '展开主导航' }).querySelector('span')).toBeNull()
    top.unmount()

    const bottom = render(<EdgeDock edge="bottom" label="展开论文切换"><button>论文</button></EdgeDock>)
    expect(bottom.getByRole('button', { name: '展开论文切换' }).querySelector('span')).not.toBeNull()
  })
})
