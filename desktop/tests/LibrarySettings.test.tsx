// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { CopilotixDesktopApi } from '@shared/types'
import SettingsPage from '../src/renderer/pages/SettingsPage'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
async function mount(manageLibrary: CopilotixDesktopApi['manageLibrary']) {
  const getStorageInfo = vi.fn(async () => ({ rootPath: 'C:/output', exists: true, documentCount: 0, fileCount: 0, totalBytes: 0, categories: [], growth: [] }))
  Object.defineProperty(window, 'copilotix', { configurable: true, value: {
    manageLibrary, getStorageInfo, getUsageAnalytics: vi.fn(async () => ({ days: [] }))
  } as unknown as CopilotixDesktopApi })
  render(<SettingsPage settings={{ ...DEFAULT_SETTINGS, outputRoot: 'C:/output' }} onSaved={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /文件存储/u }))
  await waitFor(() => expect((screen.getByRole('button', { name: '备份文档库' }) as HTMLButtonElement).disabled).toBe(false))
  return { getStorageInfo }
}
describe('library management settings', () => {
  it('keeps the existing layout and prevents overlapping operations', async () => {
    let finish!: (value: Awaited<ReturnType<CopilotixDesktopApi['manageLibrary']>>) => void
    const manage = vi.fn(() => new Promise<Awaited<ReturnType<CopilotixDesktopApi['manageLibrary']>>>((resolve) => { finish = resolve }))
    const { getStorageInfo } = await mount(manage)
    await vi.waitFor(() => expect(getStorageInfo).toHaveBeenCalledOnce())
    const storage = screen.getByRole('region', { name: '文件存储' })
    expect(document.querySelector('.settings-content-body > .settings-section.storage-management')).toBe(storage)
    expect(storage.firstElementChild?.classList.contains('storage-location-card')).toBe(true)
    expect(screen.queryByRole('heading', { name: '文件存储' })).toBeNull()
    const library = within(storage).getByRole('region', { name: '文档库管理' })
    expect(within(library).getByText(/不包含 API 密钥/u)).toBeTruthy()
    const backup = within(library).getByRole('button', { name: '备份文档库' }) as HTMLButtonElement
    const migrate = within(library).getByRole('button', { name: '迁移文档库' }) as HTMLButtonElement
    fireEvent.click(backup)
    expect(backup.disabled).toBe(true)
    expect(migrate.disabled).toBe(true)
    fireEvent.click(migrate)
    expect(manage).toHaveBeenCalledOnce()
    expect(manage).toHaveBeenCalledWith({ action: 'backup' })
    finish({ status: 'completed', path: 'D:/backup', restartRequired: false })
    await vi.waitFor(() => expect(getStorageInfo).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(backup.disabled).toBe(false))
  })
  it('does not refresh or report success when native selection is cancelled', async () => {
    const manage = vi.fn(async () => ({ status: 'cancelled' as const, restartRequired: false }))
    const { getStorageInfo } = await mount(manage)
    await vi.waitFor(() => expect(getStorageInfo).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: '恢复文档库' }))
    await screen.findByText('文档库操作已取消')
    expect(getStorageInfo).toHaveBeenCalledOnce()
    expect(screen.queryByText(/操作完成/u)).toBeNull()
  })
  it('shows failures and allows retry without refreshing data', async () => {
    const manage = vi.fn(async () => { throw new Error('备份校验失败') })
    const { getStorageInfo } = await mount(manage)
    await vi.waitFor(() => expect(getStorageInfo).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: '恢复文档库' }))
    await screen.findByText('备份校验失败')
    expect(getStorageInfo).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect((screen.getByRole('button', { name: '恢复文档库' }) as HTMLButtonElement).disabled).toBe(false))
  })
  it('announces restart without requesting a stale library after a successful switch', async () => {
    const manage = vi.fn(async () => ({ status: 'completed' as const, path: 'D:/library', restartRequired: true }))
    const { getStorageInfo } = await mount(manage)
    await vi.waitFor(() => expect(getStorageInfo).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: '迁移文档库' }))
    await screen.findByText('文档库操作完成，应用即将重启')
    expect(getStorageInfo).toHaveBeenCalledOnce()
  })
})
