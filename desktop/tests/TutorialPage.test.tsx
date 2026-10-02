// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { TUTORIAL_PAPER_SHA256 } from '@shared/tutorialSample'
import type { DocumentSummary } from '@shared/ipcSchemas'
import type { CopilotixDesktopApi } from '@shared/types'
import TutorialPage from '../src/renderer/pages/TutorialPage'

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear() })

const sample: DocumentSummary = {
  id: '4ca35161-60ba-41ee-a4fb-d02ed196e75b',
  originalName: 'Attention Is All You Need.pdf',
  displayName: 'Attention Is All You Need.pdf',
  sourceHash: TUTORIAL_PAPER_SHA256,
  workflow: { status: 'queued', progress: 0, activeJobKind: 'parse', error: null },
  processing: { translationProvider: 'qwen' },
  createdAt: '2026-09-28T00:00:00Z',
  updatedAt: '2026-09-28T00:00:00Z'
}

describe('TutorialPage', () => {
  it('guides a new user to configure MinerU before importing the bundled paper', () => {
    Object.defineProperty(window, 'copilotix', { configurable: true, value: {} as CopilotixDesktopApi })
    render(<TutorialPage settings={DEFAULT_SETTINGS} documents={[]} onSettingsSaved={vi.fn()} onOpenReader={vi.fn()} onImported={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: /用一篇经典论文/u })).toBeTruthy()
    expect(screen.getByText('Attention Is All You Need!')).toBeTruthy()
    expect((screen.getByRole('link', { name: /前往 MinerU API 申领页/u }) as HTMLAnchorElement).href).toBe('https://mineru.net/apiManage/token')
    expect(screen.queryByRole('button', { name: /沿用已保存的 API/u })).toBeNull()
    expect((screen.getByRole('button', { name: '选择文档' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '输入申领到的 API' }))
    expect(screen.getByRole('dialog', { name: '连接 MinerU API' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '验证并保存' }))
    expect(screen.getByRole('alert').textContent).toContain('请先输入')
  })

  it('imports the fixed sample once and follows its task into the reader', async () => {
    window.localStorage.setItem('copilotix:tutorial:api-verified:v1', '1')
    const importTutorialPaper = vi.fn(async () => sample)
    Object.defineProperty(window, 'copilotix', { configurable: true, value: { importTutorialPaper } as unknown as CopilotixDesktopApi })
    const onImported = vi.fn()
    const onOpenReader = vi.fn()
    const settings = { ...DEFAULT_SETTINGS, credentials: { ...DEFAULT_SETTINGS.credentials, parser: { state: 'valid' as const } } }
    const view = render(<TutorialPage settings={settings} documents={[]} onSettingsSaved={vi.fn()} onOpenReader={onOpenReader} onImported={onImported} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '选择文档' }))
    await waitFor(() => expect(importTutorialPaper).toHaveBeenCalledWith(false))
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(sample))
    expect(screen.getByText(/任务开始后，解析与翻译会依次进行/u)).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '解析进度' }).getAttribute('aria-valuenow')).toBe('0')
    expect(screen.getByRole('progressbar', { name: '翻译进度' }).getAttribute('aria-valuenow')).toBe('0')
    expect((screen.getByRole('button', { name: /论文已加入任务/u }) as HTMLButtonElement).disabled).toBe(true)
    view.rerender(<TutorialPage settings={settings} documents={[{ ...sample, workflow: { ...sample.workflow, status: 'completed', progress: 100, activeJobKind: null } }]} onSettingsSaved={vi.fn()} onOpenReader={onOpenReader} onImported={onImported} onClose={vi.fn()} />)
    expect(screen.getByRole('progressbar', { name: '解析进度' }).getAttribute('aria-valuenow')).toBe('100')
    expect(screen.getByRole('progressbar', { name: '翻译进度' }).getAttribute('aria-valuenow')).toBe('100')
    expect(screen.getByText(/任务开始后，解析与翻译会依次进行/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /跳转论文阅读器/u }))
    expect(onOpenReader).toHaveBeenCalledWith(sample.id)
    expect(window.localStorage.getItem(`copilotix:tutorial:read:${sample.id}`)).toBe('1')
  })

  it('does not create a task when the file picker is cancelled', async () => {
    window.localStorage.setItem('copilotix:tutorial:api-verified:v1', '1')
    const importTutorialPaper = vi.fn(async () => null)
    Object.defineProperty(window, 'copilotix', { configurable: true, value: { importTutorialPaper } as unknown as CopilotixDesktopApi })
    const onImported = vi.fn()
    const settings = { ...DEFAULT_SETTINGS, credentials: { ...DEFAULT_SETTINGS.credentials, parser: { state: 'valid' as const } } }
    render(<TutorialPage settings={settings} documents={[]} onSettingsSaved={vi.fn()} onOpenReader={vi.fn()} onImported={onImported} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '选择文档' }))
    await waitFor(() => expect(importTutorialPaper).toHaveBeenCalledOnce())
    expect(onImported).not.toHaveBeenCalled()
  })

  it('restarts with a new task while preserving the previous sample', async () => {
    window.localStorage.setItem('copilotix:tutorial:api-verified:v1', '1')
    const previous = { ...sample, workflow: { ...sample.workflow, status: 'completed' as const, progress: 100, activeJobKind: null } }
    const next = { ...sample, id: '86f3f3e6-44cd-43f9-8886-77f6376a619a' }
    const importTutorialPaper = vi.fn(async () => next)
    const settings = { ...DEFAULT_SETTINGS, credentials: { ...DEFAULT_SETTINGS.credentials, parser: { state: 'valid' as const } } }
    Object.defineProperty(window, 'copilotix', { configurable: true, value: {
      importTutorialPaper,
      validateCredential: vi.fn(async () => ({ state: 'valid' as const })),
      saveSettings: vi.fn(async () => ({ settings, fieldErrors: {} }))
    } as unknown as CopilotixDesktopApi })
    const onImported = vi.fn()
    render(<TutorialPage settings={settings} documents={[previous]} onSettingsSaved={vi.fn()} onOpenReader={vi.fn()} onImported={onImported} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '重新体验教程' }))
    expect(window.localStorage.getItem('copilotix:tutorial:replay')).toBe('1')
    expect((screen.getByRole('button', { name: '选择文档' }) as HTMLButtonElement).disabled).toBe(true)
    expect(window.localStorage.getItem('copilotix:tutorial:api-verified:v1')).toBeNull()
    expect(previous.workflow.status).toBe('completed')
    fireEvent.click(screen.getByRole('button', { name: '输入申领到的 API' }))
    fireEvent.change(screen.getByLabelText('MinerU Token'), { target: { value: 'test-token' } })
    fireEvent.click(screen.getByRole('button', { name: '验证并保存' }))
    await waitFor(() => expect((screen.getByRole('button', { name: '选择文档' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '选择文档' }))
    await waitFor(() => expect(importTutorialPaper).toHaveBeenCalledWith(true))
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(next))
    expect(window.localStorage.getItem('copilotix:tutorial:active-id')).toBe(next.id)
  })

  it('validates the MinerU token and saves it only after success', async () => {
    const validateCredential = vi.fn(async () => ({ state: 'valid' as const }))
    const validSettings = { ...DEFAULT_SETTINGS, credentials: { ...DEFAULT_SETTINGS.credentials, parser: { state: 'valid' as const } } }
    const saveSettings = vi.fn(async () => ({ settings: validSettings, fieldErrors: {} }))
    Object.defineProperty(window, 'copilotix', { configurable: true, value: { validateCredential, saveSettings } as unknown as CopilotixDesktopApi })
    const onSettingsSaved = vi.fn()
    render(<TutorialPage settings={DEFAULT_SETTINGS} documents={[]} onSettingsSaved={onSettingsSaved} onOpenReader={vi.fn()} onImported={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '输入申领到的 API' }))
    fireEvent.change(screen.getByLabelText('MinerU Token'), { target: { value: 'test-token' } })
    fireEvent.click(screen.getByRole('button', { name: '验证并保存' }))
    await waitFor(() => expect(validateCredential).toHaveBeenCalledWith('parser', 'test-token'))
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ credentialMutations: { parser: { action: 'set', value: 'test-token' } } })))
    expect(onSettingsSaved).toHaveBeenCalledWith(validSettings)
  })

  it('uses the same completion mark on all four finished steps', async () => {
    window.localStorage.setItem('copilotix:tutorial:api-verified:v1', '1')
    window.localStorage.setItem(`copilotix:tutorial:read:${sample.id}`, '1')
    Object.defineProperty(window, 'copilotix', { configurable: true, value: {} as CopilotixDesktopApi })
    const settings = { ...DEFAULT_SETTINGS, credentials: { ...DEFAULT_SETTINGS.credentials, parser: { state: 'valid' as const } } }
    const completed = { ...sample, workflow: { ...sample.workflow, status: 'completed' as const, progress: 100, activeJobKind: null } }
    const { container } = render(<TutorialPage settings={settings} documents={[completed]} onSettingsSaved={vi.fn()} onOpenReader={vi.fn()} onImported={vi.fn()} onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.tutorial-step-completion')).toHaveLength(4))
    expect(Array.from(container.querySelectorAll('.tutorial-step-top .ant-tag')).map((tag) => tag.textContent)).toEqual(['已完成', '已完成', '已完成', '已完成'])
  })
})
