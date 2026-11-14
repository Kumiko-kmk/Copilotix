// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@features/settings/contract/defaultSettings'
import type { AppSettings, SettingsUpdate } from '@features/settings/contract/settingsTypes'
import type { CopilotixDesktopApi } from '@app/contract/desktopApi'
import SettingsPage from '../../../src/features/settings/renderer/SettingsPage'

let saveSettings: ReturnType<typeof vi.fn>

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    outputRoot: 'C:\\output',
    credentials: { parser: { state: 'missing' }, qwen: { state: 'missing' }, deepseek: { state: 'valid', maskedValue: 'sk-****9a2f' } },
    keyStatuses: { 'deepseek:default': { state: 'valid', maskedValue: 'sk-****9a2f' } },
    ...overrides
  }
}

beforeEach(() => {
  saveSettings = vi.fn(async (update: SettingsUpdate) => {
    const { credentialMutations: _credentials, keyMutations: _keys, ...rest } = update
    return { settings: { ...settings(), ...rest }, fieldErrors: {} }
  })
  Object.defineProperty(window, 'copilotix', {
    configurable: true,
    value: {
      saveSettings,
      getSettings: vi.fn(async () => settings()),
      getUsageAnalytics: vi.fn(async () => ({ days: [] })),
      validateCredential: vi.fn(async () => ({ state: 'valid' as const })),
      codex: { cached: vi.fn(async () => null), inspect: vi.fn(async () => ({ state: 'missing', executable: '', version: '', message: '', models: [], verifiedModels: [] })), selectExecutable: vi.fn(async () => null) }
    } as unknown as CopilotixDesktopApi
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const row = (name: string) => within(document.querySelector(`.lite-service[data-service="${name}"]`) as HTMLElement)
async function save(): Promise<SettingsUpdate> {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '儲存全部更改' })) })
  expect(saveSettings).toHaveBeenCalledOnce()
  return saveSettings.mock.calls[0]![0] as SettingsUpdate
}

describe('Lite settings window', () => {
  it('has three flat sections and no key manager, model page, advanced options or explanations', () => {
    render(<SettingsPage settings={settings()} onSaved={vi.fn()} onExit={vi.fn()} />)
    const nav = within(screen.getByRole('navigation', { name: '設定分類' }))
    expect(nav.getAllByRole('button').map((button) => button.textContent)).toEqual(['服務', '儲存', '外觀'])
    for (const hidden of ['API 金鑰', '模型設定', '高階設定', '管理金鑰', '使用順序']) expect(screen.queryByText(hidden)).toBeNull()
    expect(document.querySelector('details, .ant-tabs, .api-key-tabs, small')).toBeNull()
    expect([...document.querySelectorAll('.lite-service')].map((element) => element.getAttribute('data-service'))).toEqual(['MinerU', '千問', 'DeepSeek', 'Codex'])
    // A stored key shows only its masked form; nothing waits to be saved yet.
    expect(row('DeepSeek').getByLabelText('DeepSeek API Key').getAttribute('placeholder')).toBe('sk-****9a2f')
    expect(row('DeepSeek').getByText('已驗證')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '儲存全部更改' })).toBeNull()
  })

  it('saves a pasted key into the provider default connection', async () => {
    render(<SettingsPage settings={settings()} onSaved={vi.fn()} onExit={vi.fn()} />)
    fireEvent.change(row('千問').getByLabelText('千問 API Key'), { target: { value: 'sk-qwen-new' } })
    expect(row('千問').getByText('待儲存')).toBeTruthy()
    const update = await save()
    expect(update.keyMutations).toEqual({ 'qwen:default': { action: 'set', value: 'sk-qwen-new' } })
    expect(update.modelConnections?.some((connection) => connection.connectionId === 'qwen:default')).toBe(true)
  })

  it('creates the default connection when the provider had none, and deleting removes it', async () => {
    const view = render(<SettingsPage settings={settings({ modelConnections: (DEFAULT_SETTINGS.modelConnections ?? []).filter((connection) => connection.provider !== 'qwen') })} onSaved={vi.fn()} onExit={vi.fn()} />)
    fireEvent.change(row('千問').getByLabelText('千問 API Key'), { target: { value: 'sk-qwen-first' } })
    const update = await save()
    expect(update.keyMutations).toEqual({ 'qwen:default': { action: 'set', value: 'sk-qwen-first' } })
    expect(update.modelConnections?.filter((connection) => connection.provider === 'qwen').map((connection) => connection.connectionId)).toEqual(['qwen:default'])
    view.unmount(); saveSettings.mockClear()

    render(<SettingsPage settings={settings()} onSaved={vi.fn()} onExit={vi.fn()} />)
    fireEvent.click(row('DeepSeek').getByRole('button', { name: '刪除 DeepSeek API Key' }))
    const removal = await save()
    expect(removal.modelConnections?.some((connection) => connection.provider === 'deepseek')).toBe(false)
  })

  it('turns translation use on and off from the row switch', async () => {
    render(<SettingsPage settings={settings()} onSaved={vi.fn()} onExit={vi.fn()} />)
    const before = settings().enabledTranslationProviders
    expect(before).toContain('deepseek')
    fireEvent.click(row('DeepSeek').getByRole('switch', { name: '用DeepSeek翻譯' }))
    const update = await save()
    expect(update.enabledTranslationProviders).not.toContain('deepseek')
  })

  it('sends a pasted MinerU token as a credential change', async () => {
    render(<SettingsPage settings={settings()} onSaved={vi.fn()} onExit={vi.fn()} />)
    fireEvent.change(row('MinerU').getByLabelText('MinerU Token'), { target: { value: 'mineru-token' } })
    const update = await save()
    expect(update.credentialMutations).toEqual({ parser: { action: 'set', value: 'mineru-token' } })
  })
})
