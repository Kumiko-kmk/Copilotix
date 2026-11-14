// @vitest-environment jsdom
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfigProvider } from 'antd'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@features/settings/contract/defaultSettings'
import type { AppSettings, SettingsUpdate } from '@features/settings/contract/settingsTypes'
import App from '../../src/app/renderer/App'

vi.mock('../../src/app/renderer/WindowControls', () => ({ default: () => null }))
vi.mock('../../src/app/renderer/EdgeDock', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('../../src/features/library/renderer/NewParsePage', () => ({ default: () => <section aria-label="新解析頁面" /> }))
vi.mock('../../src/features/library/renderer/TutorialPage', () => ({ default: () => <section aria-label="教學頁面" /> }))
vi.mock('../../src/features/reader/renderer/ReaderPage', () => ({ default: () => <section aria-label="閱讀頁面" /> }))
vi.mock('../../src/features/library/renderer/LibraryPage', () => ({ default: () => <section aria-label="文庫頁面" /> }))

let client: QueryClient
let settings: AppSettings
let saveSettings: ReturnType<typeof vi.fn>
let openDocument: (id: string) => void
beforeEach(() => {
  window.localStorage.setItem('copilotix:tutorial:seen:v1', '1')
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })) })
  settings = structuredClone(DEFAULT_SETTINGS)
  saveSettings = vi.fn(async (update: SettingsUpdate) => {
    const { credentialMutations: _mutations, ...publicSettings } = update
    settings = { ...publicSettings, credentials: settings.credentials }
    return { settings, fieldErrors: {} }
  })
  Object.defineProperty(window, 'copilotix', { configurable: true, value: {
    getSettings: async () => settings, listDocuments: async () => [],
    onDocumentsChanged: () => () => undefined,
    onOpenDocument: (listener: typeof openDocument) => { openDocument = listener; return () => undefined },
    paperInsight: {
      get: async () => ({ status: 'missing' }), list: async () => [],
      generate: async () => undefined, cancel: async () => ({ cancelled: false }),
      onChanged: () => () => undefined
    },
    getUsageAnalytics: async () => ({ days: [] }), saveSettings
  } })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  client.setQueryData(['settings'], settings)
  client.setQueryData(['documents'], { revision: 0, documents: [] })
})
afterEach(() => { cleanup(); client.clear(); window.localStorage.clear(); vi.restoreAllMocks() })

async function edit() {
  // Navigation guards need the real settings page and modal, without exit animations.
  render(<QueryClientProvider client={client}><ConfigProvider theme={{ token: { motion: false } }}><App /></ConfigProvider></QueryClientProvider>)
  fireEvent.click(within(screen.getByRole('navigation', { name: '主導覽' })).getByRole('button', { name: /設定$/u }))
  await screen.findByRole('navigation', { name: '設定分類' })
  fireEvent.click(settingsNavigation().getByRole('button', { name: /模型設定/u }))
  fireEvent.click(screen.getByLabelText('啟用千問 / Qwen'))
  expect(screen.getByText('有未儲存的更改')).toBeTruthy()
}
function leave() { fireEvent.click(within(screen.getByRole('navigation', { name: '主導覽' })).getByRole('button', { name: /新解析$/u })) }
function settingsNavigation() { return within(screen.getByRole('navigation', { name: '設定分類' })) }
function dialogButton(name: string) { return within(screen.getByRole('dialog')).getByRole('button', { name }) }

it('continues editing or explicitly discards unsaved settings before navigation', async () => {
  await edit(); leave()
  fireEvent.click(dialogButton('繼續編輯'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect((screen.getByLabelText('啟用千問 / Qwen') as HTMLInputElement).checked).toBe(false)
  leave(); fireEvent.click(dialogButton('放棄並離開'))
  await waitFor(() => expect(screen.getByRole('region', { name: '新解析頁面' })).toBeTruthy())
  expect(saveSettings).not.toHaveBeenCalled()
})
it('saves successfully before leaving', async () => {
  await edit(); leave(); fireEvent.click(dialogButton('儲存並離開'))
  await waitFor(() => expect(screen.getByRole('region', { name: '新解析頁面' })).toBeTruthy())
  expect(saveSettings).toHaveBeenCalledOnce()
  expect(settings.enabledTranslationProviders).not.toContain('qwen')
})
it('stays on the settings page and retains drafts when saving fails', async () => {
  await edit(); saveSettings.mockRejectedValueOnce(new Error('儲存失敗'))
  leave(); fireEvent.click(dialogButton('儲存並離開'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.queryByRole('region', { name: '新解析頁面' })).toBeNull()
  expect(screen.getByText('有未儲存的更改')).toBeTruthy()
  expect((screen.getByLabelText('啟用千問 / Qwen') as HTMLInputElement).checked).toBe(false)
})
it('guards native document-open requests and retains failed credential fields after a partial save', async () => {
  await edit()
  saveSettings.mockImplementationOnce(async (update: SettingsUpdate) => ({ settings, fieldErrors: {},
    keyErrors: Object.fromEntries(Object.keys(update.keyMutations ?? {}).map(id => [id, { code: 'CREDENTIAL_INVALID', message: '金鑰無效' }])) }))
  fireEvent.click(settingsNavigation().getByRole('button', { name: /API 金鑰/u }))
  fireEvent.change(screen.getByLabelText('新 API Key'), { target: { value: 'invalid-test-key' } })
  fireEvent.click(screen.getByRole('button', { name: /新增/u }))
  fireEvent.click(settingsNavigation().getByRole('button', { name: /模型設定/u }))
  await waitFor(() => expect(openDocument).toBeTypeOf('function'))
  // Use an actual event so React processes the native callback through its normal event boundary.
  const trigger = document.createElement('button'); trigger.onclick = () => openDocument('00000000-0000-4000-8000-000000000001'); document.body.append(trigger); fireEvent.click(trigger); trigger.remove()
  fireEvent.click(dialogButton('儲存並離開'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.queryByRole('region', { name: '閱讀頁面' })).toBeNull()
  fireEvent.click(settingsNavigation().getByRole('button', { name: /API 金鑰/u }))
  expect(screen.getByDisplayValue('invalid-test-key')).toBeTruthy()
  expect(screen.getByText('金鑰無效')).toBeTruthy()
})
