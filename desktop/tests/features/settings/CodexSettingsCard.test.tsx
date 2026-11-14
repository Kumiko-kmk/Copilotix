// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CodexSettingsCard } from '@features/settings/renderer/CodexSettingsCard'
import { DEFAULT_CODEX_SETTINGS, type CodexSettings, type CodexStatus } from '@platform/codex/contract/codex'

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {} }) })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function Editor({ settings }: { settings: CodexSettings }) {
  const [value, setValue] = React.useState(settings)
  return <CodexSettingsCard value={value} onChange={setValue} />
}
const model = { id: 'test-model', name: 'Test model', image: true, isDefault: true, efforts: ['high'], defaultEffort: 'high' }
const ready = (executable: string): CodexStatus => ({ state: 'ready', executable, version: 'test', message: 'Connected', models: [model], verifiedModels: [] })

it('reads saved status without probing and verifies the discovered model once through one primary action', async () => {
  const settings = { ...DEFAULT_CODEX_SETTINGS, executable: 'single-action-codex.exe' }
  const cached = vi.fn(async () => null)
  const inspect = vi.fn(async ({ testModel }: { testModel?: string }) => ({ ...ready(settings.executable), verifiedModels: testModel ? [testModel] : [] }))
  Object.defineProperty(window, 'copilotix', { configurable: true, value: { codex: { cached, inspect, selectExecutable: vi.fn() } } })
  render(<Editor settings={settings} />)
  await waitFor(() => expect(cached).toHaveBeenCalledOnce())
  expect(inspect).not.toHaveBeenCalled()
  const card = screen.getByRole('region', { name: 'Codex 連線' })
  expect(within(card).getAllByRole('button').map(button => button.textContent)).toEqual(['選擇程式', '驗證連線'])
  expect(card.querySelector('details')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '驗證連線' }))
  await waitFor(() => expect(screen.getByText('驗證成功')).toBeTruthy())
  expect(inspect).toHaveBeenCalledTimes(2)
  expect(inspect.mock.calls.map(([request]) => request.testModel)).toEqual([undefined, 'test-model'])
})

it('stops after a missing installation and can retry the same action after selecting a program', async () => {
  const settings = { ...DEFAULT_CODEX_SETTINGS, executable: 'missing-test-codex.exe' }
  const inspect = vi.fn(async ({ settings: selected, testModel }: { settings: CodexSettings; testModel?: string }): Promise<CodexStatus> => selected.executable === settings.executable
    ? { state: 'missing', executable: selected.executable, version: '', message: 'Codex not found', models: [], verifiedModels: [] }
    : { ...ready(selected.executable), verifiedModels: testModel ? [testModel] : [] })
  const selectExecutable = vi.fn(async () => 'chosen-test-codex.exe')
  Object.defineProperty(window, 'copilotix', { configurable: true, value: { codex: { cached: vi.fn(async () => null), inspect, selectExecutable } } })
  render(<Editor settings={settings} />)
  fireEvent.click(screen.getByRole('button', { name: '驗證連線' }))
  await screen.findByText('未找到')
  expect(inspect).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '選擇程式' }))
  await waitFor(() => expect((screen.getByLabelText('程式') as HTMLInputElement).value).toBe('chosen-test-codex.exe'))
  fireEvent.click(screen.getByRole('button', { name: '驗證連線' }))
  await screen.findByText('驗證成功')
  expect(inspect).toHaveBeenCalledTimes(3)
})
