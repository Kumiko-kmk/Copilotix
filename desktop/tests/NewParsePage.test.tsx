// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { CopilotixDesktopApi } from '@shared/types'
import NewParsePage from '../src/renderer/pages/NewParsePage'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('NewParsePage', () => {
  it('uses simplified Chinese and accepts a PDF dropped anywhere in the window', async () => {
    Object.defineProperty(window, 'copilotix', {
      configurable: true,
      value: { importDocuments: vi.fn() } as unknown as CopilotixDesktopApi
    })
    render(<NewParsePage settings={DEFAULT_SETTINGS} onCreated={vi.fn()} onOpenSettings={vi.fn()} />)
    const uploadEntry = screen.getByTestId('pdf-upload-entry')
    const file = new File(['%PDF-1.4'], 'window-drop.pdf', { type: 'application/pdf' })
    const dataTransfer = { types: ['Files'], files: [file], dropEffect: 'none' }

    expect(screen.getByRole('heading', { name: '今天想读些什么？' })).toBeTruthy()
    fireEvent.dragEnter(window, { dataTransfer })
    expect(uploadEntry.classList.contains('dragging')).toBe(true)
    fireEvent.drop(window, { dataTransfer })

    expect(await screen.findByText('window-drop.pdf')).toBeTruthy()
    expect(uploadEntry.classList.contains('dragging')).toBe(false)
  })
})
