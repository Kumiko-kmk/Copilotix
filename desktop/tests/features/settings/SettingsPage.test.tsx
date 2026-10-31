// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@features/settings/contract/defaultSettings'
import type { AppSettings } from '@features/settings/contract/settingsTypes'
import type { CopilotixDesktopApi } from '@app/contract/desktopApi'
import SettingsPage from '../../../src/features/settings/renderer/SettingsPage'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SettingsPage appearance', () => {
  it('previews themes, reader text size and line height at once, saves them with the page and reverts them on discard', async () => {
    const saveSettings = vi.fn()
    Object.defineProperty(window, 'copilotix', {
      configurable: true,
      value: { getUsageAnalytics: vi.fn(async () => ({ days: [] })), saveSettings } as unknown as CopilotixDesktopApi
    })
    window.localStorage.removeItem('copilotix.theme.v1')
    window.localStorage.removeItem('copilotix.reader.font-size.v1')
    window.localStorage.removeItem('copilotix.reader.line-height.v1')
    const root = document.documentElement
    const view = render(<SettingsPage settings={configuredSettings()} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /显示设置/u }))
    expect(screen.getByRole('region', { name: '显示设置' })).toBeTruthy()
    expect(document.querySelector('.settings-content-body > .settings-section.theme-settings')).toBeTruthy()
    expect(within(screen.getByRole('radiogroup', { name: '浅色主题' })).getAllByRole('radio')).toHaveLength(3)
    expect(within(screen.getByRole('radiogroup', { name: '深色主题' })).getAllByRole('radio')).toHaveLength(3)

    // A choice previews everywhere at once but is only a draft until saved.
    fireEvent.click(screen.getByRole('radio', { name: /朱砂/u }))
    fireEvent.click(screen.getByRole('button', { name: '增大阅读字号' }))
    fireEvent.click(screen.getByRole('button', { name: '增大阅读行间距' }))
    expect(root.style.getPropertyValue('--primary')).toBe('#b8432f')
    expect(root.style.getPropertyValue('--theme-archive-tray')).toBe('#86553e')
    expect(root.style.getPropertyValue('--reader-font-size')).toBe('17px')
    expect(root.style.getPropertyValue('--reader-line-height')).toBe('1.9')
    expect(window.localStorage.getItem('copilotix.theme.v1')).toBeNull()
    expect(screen.getByText('有未保存的更改')).toBeTruthy()

    // Appearance alone saves locally, without the settings IPC.
    fireEvent.click(screen.getByRole('button', { name: /保存全部更改/u }))
    await vi.waitFor(() => expect(screen.getByText('所有更改均已保存')).toBeTruthy())
    expect(saveSettings).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('copilotix.theme.v1')).toBe('cinnabar')
    expect(window.localStorage.getItem('copilotix.reader.font-size.v1')).toBe('17')
    expect(window.localStorage.getItem('copilotix.reader.line-height.v1')).toBe('1.9')

    // Night themes switch the whole palette; discarding returns to the saved choice.
    fireEvent.click(screen.getByRole('radio', { name: /深靛/u }))
    fireEvent.change(screen.getByRole('slider', { name: '阅读行间距' }), { target: { value: '1.4' } })
    expect(root.style.getPropertyValue('--reader-line-height')).toBe('1.4')
    expect(root.style.colorScheme).toBe('dark')
    expect(root.style.getPropertyValue('--on-ink')).toBe('#11151d')
    expect(root.style.getPropertyValue('--shadow-ink')).toBe('#000000')
    fireEvent.click(screen.getByRole('button', { name: /放弃更改/u }))
    expect(root.style.getPropertyValue('--primary')).toBe('#b8432f')
    expect(root.style.colorScheme).toBe('light')
    expect(root.style.getPropertyValue('--reader-line-height')).toBe('1.9')

    // Leaving with an unsaved preview never keeps it.
    fireEvent.click(screen.getByRole('radio', { name: /深靛/u }))
    view.unmount()
    expect(root.style.getPropertyValue('--primary')).toBe('#b8432f')
    window.localStorage.removeItem('copilotix.theme.v1')
    window.localStorage.removeItem('copilotix.reader.font-size.v1')
    window.localStorage.removeItem('copilotix.reader.line-height.v1')
  }, 30_000)
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
    expect(dashboard.querySelectorAll('.token-line')).toHaveLength(3)
  })

  it('keeps the services page to MinerU, a model key summary and Codex', async () => {
    Object.defineProperty(window, 'copilotix', { configurable: true, value: { getUsageAnalytics: vi.fn(async () => ({ days: [] })), getSettings: vi.fn(async () => configuredSettings()) } as unknown as CopilotixDesktopApi })
    render(<SettingsPage settings={configuredSettings()} onSaved={vi.fn()} />)
    expect(screen.getByRole('region', { name: '服务连接' })).toBeTruthy()
    expect(document.querySelector('.settings-content-body > .settings-section.service-connections')).toBeTruthy()
    expect(screen.queryByText('文档解析必需')).toBeNull()
    expect(screen.getAllByLabelText('APIKey')).toHaveLength(1)
    expect(screen.queryByText('服务地址')).toBeNull()
    expect(screen.getAllByRole('button', { name: '测试连接' })).toHaveLength(2)
    const keys = document.querySelector('[data-provider="model-keys"]') as HTMLElement
    expect(within(keys).getByText('DeepSeek 1 个 · 千问 1 个')).toBeTruthy()
    expect(document.querySelector('[data-provider="qwen"]')).toBeNull()
    fireEvent.click(within(keys).getByRole('button', { name: '管理密钥' }))
    expect(screen.getByRole('region', { name: 'API 密钥' })).toBeTruthy()
    const settingsContent = document.querySelector('.settings-content')!
    expect(settingsContent.lastElementChild?.classList.contains('settings-actions')).toBe(true)
  })

  it('manages several keys per provider and saves replacements, additions and deletions explicitly', async () => {
    const settings = configuredSettings()
    const saveSettings = vi.fn(async (update: Parameters<CopilotixDesktopApi['saveSettings']>[0]) => {
      const { credentialMutations: _credentialMutations, keyMutations: _keyMutations, ...rest } = update
      const modelConnections = rest.modelConnections ?? []
      const keyStatuses = Object.fromEntries(modelConnections.filter(value => value.provider !== 'codex').map(value => [value.connectionId, { state: 'valid' as const, maskedValue: 'saved****key' }]))
      return { settings: { ...settings, ...rest, keyStatuses, credentials: settings.credentials }, fieldErrors: {} }
    })
    Object.defineProperty(window, 'copilotix', {
      configurable: true,
      value: { saveSettings, getSettings: vi.fn(async () => settings), validateCredential: vi.fn(async () => ({ state: 'valid' as const })), getUsageAnalytics: vi.fn(async () => ({ days: [] })) } as unknown as CopilotixDesktopApi
    })
    render(<SettingsPage settings={settings} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /API 密钥/u }))
    fireEvent.click(screen.getByRole('tab', { name: /千问/u }))
    const saveAll = async (): Promise<void> => { fireEvent.click(await screen.findByRole('button', { name: '保存全部更改' }, { timeout: 5000 })) }
    const row = (): HTMLElement => document.querySelector('[data-key="qwen:default"]') as HTMLElement
    expect(within(row()).getByText('qwen-****-wxyz')).toBeTruthy()
    expect(screen.queryByDisplayValue('qwen-secret-wxyz')).toBeNull()

    fireEvent.click(within(row()).getByRole('button', { name: /^更\s?换$/u }))
    fireEvent.change(within(row()).getByLabelText('新密钥'), { target: { value: 'new-qwen-secret' } })
    await saveAll()
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    const replacement = saveSettings.mock.calls[0]![0]
    expect(replacement.keyMutations).toEqual({ 'qwen:default': { action: 'set', value: 'new-qwen-secret' } })
    expect(replacement.credentialMutations).toBeUndefined()
    expect(JSON.stringify(replacement)).not.toContain('qwen-****-wxyz')

    await screen.findByRole('button', { name: '保存全部更改' }, { timeout: 5000 })
    fireEvent.change(screen.getByLabelText('新密钥名称'), { target: { value: '备用' } })
    fireEvent.change(screen.getByLabelText('新 API Key'), { target: { value: 'backup-key' } })
    fireEvent.click(screen.getByRole('button', { name: /添加/u }))
    expect(screen.getByDisplayValue('备用')).toBeTruthy()
    await saveAll()
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2))
    const addition = saveSettings.mock.calls[1]![0]
    const [addedId, addedMutation] = Object.entries(addition.keyMutations ?? {})[0]!
    expect(addedId).toMatch(/^qwen:[0-9a-f-]{36}$/u)
    expect(addedMutation).toEqual({ action: 'set', value: 'backup-key' })
    expect(addition.modelConnections?.filter(value => value.provider === 'qwen').map(value => [value.connectionId, value.label])).toEqual([['qwen:default', undefined], [addedId, '备用']])

    await screen.findByRole('button', { name: '保存全部更改' }, { timeout: 5000 })
    fireEvent.click(within(row()).getByRole('button', { name: '删除默认密钥' }))
    await saveAll()
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(3))
    const deletion = saveSettings.mock.calls[2]![0]
    expect(deletion.keyMutations).toBeUndefined()
    expect(deletion.modelConnections?.map(value => value.connectionId)).not.toContain('qwen:default')
    expect(deletion.modelConnections?.map(value => value.connectionId)).toContain(addedId)
  }, 30000)

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
      translationProviderOrder: ['deepseek', 'qwen', 'codex']
    })
    expect(screen.getByText('DeepSeek → 千问')).toBeTruthy()
  })

  it('allows disabling the last provider and retains the draft after an unsuccessful policy save', async () => {
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
    expect((onlyEnabled as HTMLInputElement).checked).toBe(false)

    fireEvent.keyDown(screen.getByRole('button', { name: '移动千问 / Qwen' }), { key: 'ArrowDown' })
    expect(screen.getAllByRole('listitem')[0]!.textContent).toContain('DeepSeek')
    expect(saveSettings).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存全部更改' }))
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    expect(screen.getAllByRole('listitem')[0]!.textContent).toContain('DeepSeek')
    expect((screen.getByRole('checkbox', { name: '启用千问 / Qwen' }) as HTMLInputElement).checked).toBe(false)
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
    },
    keyStatuses: {
      'qwen:default': { state: 'valid', maskedValue: 'qwen-****-wxyz' },
      'deepseek:default': { state: 'valid', maskedValue: 'deeps****ecret' }
    }
  }
}


describe('paper chat reuses translation settings', () => {
  it('does not expose a second API or model settings card', async () => {
    const settings = { ...configuredSettings(), chatProvider: 'qwen' as const, chatConsentVersion: 1, credentials: { ...configuredSettings().credentials, deepseek: { state: 'unknown' as const } } }
    const saveSettings = vi.fn(async (update) => ({ settings: { ...settings, ...update }, fieldErrors: {} }))
    Object.defineProperty(window, 'copilotix', { configurable: true, value: { getUsageAnalytics: vi.fn(async () => ({ days: [] })), saveSettings } })
    render(<SettingsPage settings={settings} onSaved={vi.fn()} />)
    expect(screen.getByRole('region', { name: '服务连接' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'AI 问答' })).toBeNull()
    expect(screen.queryByLabelText('Qwen 问答模型')).toBeNull()
    expect(screen.queryByLabelText('DeepSeek 问答模型')).toBeNull()
    expect(screen.queryByLabelText('服务商')).toBeNull()
    expect(saveSettings).not.toHaveBeenCalled()
  })
})
