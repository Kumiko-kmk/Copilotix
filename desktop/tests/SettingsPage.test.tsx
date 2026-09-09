// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { AppSettings, CopilotixDesktopApi } from '@shared/types'
import SettingsPage from '../src/renderer/pages/SettingsPage'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SettingsPage credential editor', () => {
  it('shows only masked values and sends a replacement or clear mutation explicitly', async () => {
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
      chooseOutputDirectory: vi.fn(async () => null)
    } as unknown as CopilotixDesktopApi
    Object.defineProperty(window, 'copilotix', { configurable: true, value: api })
    const onSaved = vi.fn()

    render(<SettingsPage settings={settings} onSaved={onSaved} />)
    expect(screen.getByText('MinerU 解析 Token')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /参数设置/u }))
    expect(screen.getByDisplayValue('qwen****wxyz')).toBeTruthy()
    expect(screen.queryByDisplayValue('qwen-secret-wxyz')).toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: /替换/u })[0]!)
    const input = screen.getByPlaceholderText('输入新凭据')
    fireEvent.change(input, { target: { value: 'new-qwen-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    const replacement = saveSettings.mock.calls[0]![0]
    expect(replacement.credentialMutations).toEqual({ qwen: { action: 'set', value: 'new-qwen-secret' } })
    expect(JSON.stringify(replacement)).not.toContain('qwen****wxyz')

    fireEvent.click(screen.getAllByRole('button', { name: /清除/u })[0]!)
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2))
    expect(saveSettings.mock.calls[1]![0].credentialMutations).toEqual({ qwen: { action: 'clear' } })
  }, 15000)
})

function configuredSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    outputRoot: 'C:\\output',
    credentials: {
      parser: { state: 'valid', maskedValue: 'pars****cret' },
      qwen: { state: 'valid', maskedValue: 'qwen****wxyz' },
      deepseek: { state: 'valid', maskedValue: 'deep****seek' }
    }
  }
}
