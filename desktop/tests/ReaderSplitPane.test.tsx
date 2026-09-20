// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ReaderSplitPane, { clampSplitPercent } from '../src/renderer/components/ReaderSplitPane'

beforeEach(() => window.sessionStorage.clear())
afterEach(cleanup)

describe('ReaderSplitPane', () => {
  it('uses the current near-even default and clamps invalid values', () => {
    expect(clampSplitPercent(Number.NaN)).toBeCloseTo(48.78, 2)
    expect(clampSplitPercent(10)).toBe(40)
    expect(clampSplitPercent(90)).toBe(60)
  })

  it('resizes with pointer input and enforces the 40–60 limits', () => {
    const view = render(<ReaderSplitPane left={<div>PDF</div>} right={<div>Markdown</div>} />)
    const container = view.container.querySelector<HTMLElement>('.reader-split')!
    const separator = view.getByRole('separator')
    Object.defineProperty(container, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 100, width: 1000, top: 0, right: 1100, bottom: 600, height: 600, x: 100, y: 0, toJSON: () => undefined })
    })

    fireEvent.pointerDown(separator, { pointerId: 1, clientX: 850 })
    expect(separator.getAttribute('aria-valuenow')).toBe('60')
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 300 })
    expect(separator.getAttribute('aria-valuenow')).toBe('40')
    fireEvent.pointerUp(separator, { pointerId: 1 })
  })

  it('supports keyboard resizing and restores a valid session value', () => {
    window.sessionStorage.setItem('copilotix.reader.split-percent', '56')
    const view = render(<ReaderSplitPane left={<div>PDF</div>} right={<div>Markdown</div>} />)
    const separator = view.getByRole('separator')
    expect(separator.getAttribute('aria-valuenow')).toBe('56')
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(separator.getAttribute('aria-valuenow')).toBe('58')
    fireEvent.keyDown(separator, { key: 'End' })
    expect(separator.getAttribute('aria-valuenow')).toBe('60')
    expect(window.sessionStorage.getItem('copilotix.reader.split-percent')).toBe('60')
  })

  it('ignores an invalid stored value', () => {
    window.sessionStorage.setItem('copilotix.reader.split-percent', 'not-a-number')
    const view = render(<ReaderSplitPane left={<div>PDF</div>} right={<div>Markdown</div>} />)
    expect(view.getByRole('separator').getAttribute('aria-valuenow')).toBe('49')
  })
})
