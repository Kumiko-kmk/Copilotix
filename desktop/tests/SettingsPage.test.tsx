// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { AppSettings, CopilotixDesktopApi } from '@shared/types'
import SettingsPage from '../src/renderer/pages/SettingsPage'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SettingsPage credential editor', () => {
  it('renders activity and provider token history in two chart panels', async () => {
    const days = Array.from({ length: 84 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 6, index + 1)).toISOString().slice(0, 10),
      documents: index === 83 ? 2 : 0,
      pages: index === 83 ? 18 : 0,
      deepseekTokens: index >= 54 ? index * 10 : 0,
      qwenTokens: index >= 54 ? index * 5 : 0
    }))
    Object.defineProperty(window, 'copilotix', {
      configurable: true,
      value: {
        getUsageAnalytics: vi.fn(async () => ({ days }))
      } as unknown as CopilotixDesktopApi
    })

    render(<SettingsPage settings={configuredSettings()} onSaved={vi.fn()} />)

    const dashboard = screen.getByRole('region', { name: 'APIKey 用量分析' })
    await vi.waitFor(() => expect(within(dashboard).getByText('共计 18 页')).toBeTruthy())
    expect(within(dashboard).getByText('活动热力')).toBeTruthy()
    expect(within(dashboard).queryByText(/份文/u)).toBeNull()
    expect(within(dashboard).getByText('模型 Token')).toBeTruthy()
    expect(dashboard.querySelectorAll('.activity-heatmap .activity-cell')).toHaveLength(84)
    expect(dashboard.querySelectorAll('.token-line')).toHaveLength(2)
  })

  it('keeps all services open and sends direct replacement or delete mutations explicitly', async () => {
    const settings = configuredSettings()
    const saveSettings = vi.fn(async (update: Parameters<CopilotixDesktopApi['saveSettings']>[0]) => ({
      settings: update.credentialMutations?.qwen?.action === 'clear'
        ? { ...settings, credentials: { ...settings.credentials, qwen: { state: 'missing' as const } } }
        : { ...settings, credentials: { ...settings.credentials, qwen: { state: 'valid' as const, maskedValue: 'new-****-key' } } },
      fieldErrors: {}
    }))
    const api = {
      saveSettings,
      validateCredential: vi.fn(async () => ({ state: 'valid' as const })),
      chooseOutputDirectory: vi.fn(async () => null),
      getUsageAnalytics: vi.fn(async () => ({ days: [] }))
    } as unknown as CopilotixDesktopApi
    Object.defineProperty(window, 'copilotix', { configurable: true, value: api })
    const onSaved = vi.fn()

    render(<SettingsPage settings={settings} onSaved={onSaved} />)
    expect(screen.getByRole('region', { name: '服务连接' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '服务连接' })).toBeNull()
    expect(document.querySelector('.settings-content-body > .settings-section.service-connections')).toBeTruthy()
    expect(screen.queryByText('文档解析必需')).toBeNull()
    expect(screen.queryByRole('button', { name: /更多/u })).toBeNull()
    expect(screen.getAllByLabelText('APIKey')).toHaveLength(3)
    expect(screen.queryByText('服务地址')).toBeNull()
    expect(screen.queryByText('高级设置')).toBeNull()
    expect(screen.getAllByRole('button', { name: '测试连接' })).toHaveLength(3)
    expect(screen.queryByText('配置服务')).toBeNull()
    expect(screen.queryByText('千问 / Qwen')).toBeNull()
    expect(screen.getByText('Qwen')).toBeTruthy()
    expect(screen.queryByText('翻译服务为可选配置；未配置时仍可使用文档解析。')).toBeNull()
    const qwenCard = document.querySelector('[data-provider="qwen"]') as HTMLElement
    expect(qwenCard).toBeTruthy()
    expect(qwenCard.querySelector('.credential-control-masked')).toBeTruthy()
    expect(screen.queryByDisplayValue('qwen-secret-wxyz')).toBeNull()

    const maskedInput = within(qwenCard).getByLabelText('APIKey')
    fireEvent.focus(maskedInput)
    const input = within(qwenCard).getByPlaceholderText('输入新密钥')
    expect(within(qwenCard).queryByRole('img', { name: /eye/u })).toBeNull()
    expect(within(qwenCard).queryByRole('button', { name: /替换/u })).toBeNull()
    fireEvent.change(input, { target: { value: 'new-qwen-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存全部更改' }))
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    const replacement = saveSettings.mock.calls[0]![0]
    expect(replacement.credentialMutations).toEqual({ qwen: { action: 'set', value: 'new-qwen-secret' } })
    expect(JSON.stringify(replacement)).not.toContain('qwen****wxyz')

    const rowActions = within(qwenCard).getAllByRole('button')
    expect(rowActions[0]!.textContent).toContain('删除')
    expect(rowActions[1]!.textContent).toContain('测试连接')
    fireEvent.click(within(qwenCard).getByRole('button', { name: /删除/u }))
    fireEvent.click(screen.getByRole('button', { name: '保存全部更改' }))
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2))
    expect(saveSettings.mock.calls[1]![0].credentialMutations).toEqual({ qwen: { action: 'clear' } })

    const settingsContent = document.querySelector('.settings-content')!
    expect(settingsContent.lastElementChild?.classList.contains('settings-actions')).toBe(true)
  }, 15000)

  it('reorders the model policy from the keyboard and saves it from the shared action bar', async () => {
    const settings = configuredSettings()
    const saveSettings = vi.fn(async (update: Parameters<CopilotixDesktopApi['saveSettings']>[0]) => ({
      settings: { ...settings, ...update, credentials: settings.credentials },
      fieldErrors: {}
    }))
    Object.defineProperty(window, 'copilotix', {
      configurable: true,
      value: {
        saveSettings,
        validateCredential: vi.fn(),
        chooseOutputDirectory: vi.fn(),
        getUsageAnalytics: vi.fn(async () => ({ days: [] }))
      } as unknown as CopilotixDesktopApi
    })

    render(<SettingsPage settings={settings} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /模型设置/u }))
    expect(screen.getByRole('region', { name: '模型设置' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '模型设置' })).toBeNull()
    expect(document.querySelector('.settings-content-body > .settings-section.model-priority')).toBeTruthy()
    expect(screen.getByText('大语言模型优先级')).toBeTruthy()
    expect((screen.getByRole('button', { name: '保存全部更改' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(screen.getByRole('button', { name: '移动千问 / Qwen' }), { key: 'ArrowDown' })
    expect(saveSettings).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: '保存全部更改' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '保存全部更改' }))
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    expect(saveSettings.mock.calls[0]![0]).toMatchObject({
      translationProvider: 'deepseek',
      translationProviderOrder: ['deepseek', 'qwen', 'bing', 'transmart']
    })
    expect(screen.getByText('DeepSeek → 千问 → Bing → Transmart')).toBeTruthy()
  })

  it('keeps the last provider enabled and retains the draft after an unsuccessful policy save', async () => {
    const settings: AppSettings = {
      ...configuredSettings(),
      translationProvider: 'qwen',
      enabledTranslationProviders: ['qwen']
    }
    const saveSettings = vi.fn(async () => { throw new Error('保存优先级失败') })
    Object.defineProperty(window, 'copilotix', {
      configurable: true,
      value: {
        saveSettings,
        validateCredential: vi.fn(),
        chooseOutputDirectory: vi.fn(),
        getUsageAnalytics: vi.fn(async () => ({ days: [] }))
      } as unknown as CopilotixDesktopApi
    })

    render(<SettingsPage settings={settings} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /模型设置/u }))
    const onlyEnabled = screen.getByRole('checkbox', { name: '启用千问 / Qwen' })
    fireEvent.click(onlyEnabled)
    expect(saveSettings).not.toHaveBeenCalled()
    expect((onlyEnabled as HTMLInputElement).checked).toBe(true)

    fireEvent.keyDown(screen.getByRole('button', { name: '移动千问 / Qwen' }), { key: 'ArrowDown' })
    expect(screen.getAllByRole('listitem')[0]!.textContent).toContain('DeepSeek')
    expect(saveSettings).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存全部更改' }))
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    expect(screen.getAllByRole('listitem')[0]!.textContent).toContain('DeepSeek')
    expect((screen.getByRole('checkbox', { name: '启用千问 / Qwen' }) as HTMLInputElement).checked).toBe(true)
  })

  it('loads storage usage and offers library migration beside export and import', async () => {
    const settings = configuredSettings()
    const saveSettings = vi.fn(async (update: Parameters<CopilotixDesktopApi['saveSettings']>[0]) => ({
      settings: { ...settings, ...update, credentials: settings.credentials },
      fieldErrors: {}
    }))
    const getStorageInfo = vi.fn(async () => ({
      rootPath: settings.outputRoot,
      exists: true,
      documentCount: 3,
      fileCount: 18,
      totalBytes: 1_572_864,
      categories: [
        { kind: 'source' as const, fileCount: 3, bytes: 524_288 },
        { kind: 'image' as const, fileCount: 10, bytes: 786_432 },
        { kind: 'translation' as const, fileCount: 3, bytes: 196_608 },
        { kind: 'other' as const, fileCount: 2, bytes: 65_536 }
      ],
      growth: Array.from({ length: 14 }, (_, index) => ({ date: `2026-09-${String(index + 10).padStart(2, '0')}`, totalBytes: (index + 1) * 112_347 }))
    }))
    const openStorageLocation = vi.fn(async () => undefined)
    const manageLibrary = vi.fn(async () => ({ status: 'cancelled' as const, restartRequired: false }))
    Object.defineProperty(window, 'copilotix', {
      configurable: true,
      value: {
        saveSettings,
        validateCredential: vi.fn(),
        chooseOutputDirectory: vi.fn(async () => 'D:\\Copilotix'),
        getStorageInfo,
        getUsageAnalytics: vi.fn(async () => ({ days: [] })),
        openStorageLocation,
        manageLibrary
      } as unknown as CopilotixDesktopApi
    })

    render(<SettingsPage settings={settings} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /文件存储/u }))
    expect(screen.getByRole('region', { name: '文件存储' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '文件管理' })).toBeNull()
    expect(document.querySelector('.settings-content-body > .settings-section.storage-management')).toBeTruthy()
    await vi.waitFor(() => expect(getStorageInfo).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(screen.getByText('3')).toBeTruthy())
    expect(screen.getByText('18')).toBeTruthy()
    expect(screen.getAllByText('1.50 MB').length).toBeGreaterThan(0)
    expect(screen.getByRole('region', { name: '存储构成' })).toBeTruthy()
    expect(screen.getByRole('img', { name: /存储构成，总计 1\.50 MB/u })).toBeTruthy()
    expect(screen.getByRole('region', { name: '近期存储增长' })).toBeTruthy()
    expect(screen.getByRole('img', { name: '近 14 日存储增长曲线' })).toBeTruthy()

    expect(screen.queryByRole('region', { name: '文档库管理' })).toBeNull()
    expect((screen.getByLabelText('文档保存位置') as HTMLInputElement).value).toBe(settings.outputRoot)
    fireEvent.click(screen.getByRole('button', { name: '迁移文库' }))
    await vi.waitFor(() => expect(manageLibrary).toHaveBeenCalledWith({ action: 'migrate' }))
    await vi.waitFor(() => expect((screen.getByRole('button', { name: '打开当前目录' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '打开当前目录' }))
    await vi.waitFor(() => expect(openStorageLocation).toHaveBeenCalledOnce())
    expect(saveSettings).not.toHaveBeenCalled()
  })
})

function configuredSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    outputRoot: 'C:\\output',
    credentials: {
      parser: { state: 'valid', maskedValue: 'parse****ecret' },
      qwen: { state: 'valid', maskedValue: 'qwen-****-wxyz' },
      deepseek: { state: 'valid', maskedValue: 'deeps****ecret' }
    }
  }
}
