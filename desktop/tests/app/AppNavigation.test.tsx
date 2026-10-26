// @vitest-environment jsdom
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfigProvider } from 'antd'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { AppSettings, SettingsUpdate } from '@shared/types'
import App from '../../src/app/renderer/App'

vi.mock('../../src/app/renderer/WindowControls', () => ({ default: () => null }))
vi.mock('../../src/app/renderer/EdgeDock', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('../../src/features/library/renderer/NewParsePage', () => ({ default: () => <section aria-label="新解析页面" /> }))
vi.mock('../../src/features/library/renderer/TutorialPage', () => ({ default: () => <section aria-label="教程页面" /> }))
vi.mock('../../src/features/reader/renderer/ReaderPage', () => ({ default: () => <section aria-label="阅读页面" /> }))
vi.mock('../../src/features/library/renderer/LibraryPage', () => ({ default: () => <section aria-label="文库页面" /> }))

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
  fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: /设置$/u }))
  fireEvent.click(settingsNavigation().getByRole('button', { name: /模型设置/u }))
  fireEvent.click(screen.getByLabelText('启用千问 / Qwen'))
  expect(screen.getByText('有未保存的更改')).toBeTruthy()
}
function leave() { fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: /新解析$/u })) }
function settingsNavigation() { return within(screen.getByRole('navigation', { name: '设置分类' })) }
function dialogButton(name: string) { return within(screen.getByRole('dialog')).getByRole('button', { name }) }

it('continues editing or explicitly discards unsaved settings before navigation', async () => {
  await edit(); leave()
  fireEvent.click(dialogButton('继续编辑'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect((screen.getByLabelText('启用千问 / Qwen') as HTMLInputElement).checked).toBe(false)
  leave(); fireEvent.click(dialogButton('放弃并离开'))
  await waitFor(() => expect(screen.getByRole('region', { name: '新解析页面' })).toBeTruthy())
  expect(saveSettings).not.toHaveBeenCalled()
})
it('saves successfully before leaving', async () => {
  await edit(); leave(); fireEvent.click(dialogButton('保存并离开'))
  await waitFor(() => expect(screen.getByRole('region', { name: '新解析页面' })).toBeTruthy())
  expect(saveSettings).toHaveBeenCalledOnce()
  expect(settings.enabledTranslationProviders).not.toContain('qwen')
})
it('stays on the settings page and retains drafts when saving fails', async () => {
  await edit(); saveSettings.mockRejectedValueOnce(new Error('保存失败'))
  leave(); fireEvent.click(dialogButton('保存并离开'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.queryByRole('region', { name: '新解析页面' })).toBeNull()
  expect(screen.getByText('有未保存的更改')).toBeTruthy()
  expect((screen.getByLabelText('启用千问 / Qwen') as HTMLInputElement).checked).toBe(false)
})
it('guards native document-open requests and retains failed credential fields after a partial save', async () => {
  await edit()
  saveSettings.mockResolvedValueOnce({ settings, fieldErrors: { qwen: { message: '密钥无效' } } })
  fireEvent.click(settingsNavigation().getByRole('button', { name: /服务连接/u }))
  const input = within(document.querySelector('[data-provider="qwen"]') as HTMLElement).getByPlaceholderText('输入新密钥')
  fireEvent.change(input, { target: { value: 'invalid-test-key' } })
  fireEvent.click(settingsNavigation().getByRole('button', { name: /模型设置/u }))
  await waitFor(() => expect(openDocument).toBeTypeOf('function'))
  // Use an actual event so React processes the native callback through its normal event boundary.
  const trigger = document.createElement('button'); trigger.onclick = () => openDocument('00000000-0000-4000-8000-000000000001'); document.body.append(trigger); fireEvent.click(trigger); trigger.remove()
  fireEvent.click(dialogButton('保存并离开'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.queryByRole('region', { name: '阅读页面' })).toBeNull()
  fireEvent.click(settingsNavigation().getByRole('button', { name: /服务连接/u }))
  expect(screen.getByDisplayValue('invalid-test-key')).toBeTruthy()
  expect(screen.getByText('密钥无效')).toBeTruthy()
})
