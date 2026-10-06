// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    const importDocuments = vi.fn(async () => ({ created: [{}], failed: [] }))
    Object.defineProperty(window, 'copilotix', {
      configurable: true,
      value: { importDocuments } as unknown as CopilotixDesktopApi
    })
    const settings = {
      ...DEFAULT_SETTINGS,
      credentials: { ...DEFAULT_SETTINGS.credentials, parser: { state: 'valid' as const } }
    }
    render(<NewParsePage settings={settings} onCreated={vi.fn()} onOpenSettings={vi.fn()} onOpenTutorial={vi.fn()} />)
    const uploadEntry = screen.getByTestId('pdf-upload-entry')
    const file = new File(['%PDF-1.4'], 'window-drop.pdf', { type: 'application/pdf' })
    const dataTransfer = { types: ['Files'], files: [file], dropEffect: 'none' }

    expect(screen.getByRole('heading', { name: '今天想读些什么？' })).toBeTruthy()
    expect(screen.getByText('拖入文档')).toBeTruthy()
    expect(screen.getByText('当前支持 PDF，单篇最多 600 页')).toBeTruthy()
    expect(screen.getByRole('button', { name: '选择文档' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /新手教程/u })).toBeTruthy()
    expect(screen.queryByText('or')).toBeNull()
    fireEvent.dragEnter(window, { dataTransfer })
    expect(uploadEntry.classList.contains('dragging')).toBe(true)
    fireEvent.drop(window, { dataTransfer })

    expect(await screen.findByText('window-drop.pdf')).toBeTruthy()
    expect(uploadEntry.classList.contains('dragging')).toBe(false)
    const useOriginalFilename = screen.getByRole('checkbox', { name: '使用原文件名' }) as HTMLInputElement
    const skipDuplicates = screen.getByRole('checkbox', { name: '跳过重复文件' }) as HTMLInputElement
    expect(useOriginalFilename.checked).toBe(false)
    expect(skipDuplicates.checked).toBe(true)
    expect(screen.queryByText('导入时会自动跳过已有相同文件')).toBeNull()
    expect(screen.queryByRole('button', { name: '重新选择' })).toBeNull()

    fireEvent.click(useOriginalFilename)
    fireEvent.click(skipDuplicates)
    fireEvent.click(screen.getByRole('button', { name: '开始解析' }))

    await waitFor(() => expect(importDocuments).toHaveBeenCalledWith(
      { createDuplicates: true, useOriginalFilename: true },
      [file]
    ))
  })
})
