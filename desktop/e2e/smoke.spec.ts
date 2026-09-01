import { _electron as electron, expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createE2EWorkspace } from './helpers'

const desktopPackage = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as {
  version: string
  build?: { productName?: string }
}
const releaseName = `${desktopPackage.build?.productName ?? 'MinerU'}-${desktopPackage.version}-win-x64`

test('opens the minimal new parse page', async () => {
  const workspace = await createE2EWorkspace()
  const app = await electron.launch({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await expect(window.locator('aside[aria-label="主导航"]')).toHaveCount(0)
    await expect(window.getByRole('group', { name: '窗口控制' })).toBeVisible()
    expect(await window.title()).toBe('')
    await window.locator('[data-edge-dock="top"]').hover()
    await expect(window.getByRole('button', { name: '任务管理' })).toBeVisible()
    await expect(window.getByText('智能解析')).toHaveCount(0)
    await expect(window.getByText('拖入 PDF 文件')).toHaveCount(0)
    await expect(window.getByRole('button', { name: '选择 PDF' })).toBeVisible()
    const uploadEntry = window.getByTestId('pdf-upload-entry')
    await expect(uploadEntry).toBeVisible()
    await expect(uploadEntry).toHaveCSS('border-radius', '24px')
    await expect(uploadEntry).not.toHaveCSS('border-style', 'dashed')
    const particleLake = window.getByTestId('particle-lake')
    await expect(particleLake).toBeVisible()
    await expect(particleLake).toHaveAttribute('data-renderer', 'webgl2')
    await expect.poll(() => particleLake.locator('canvas:not([hidden])').evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0)
    await expect.poll(() => particleLake.getAttribute('data-particle-count').then(Number)).toBeGreaterThanOrEqual(120_000)
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('supports the custom traffic-light window controls', async () => {
  const workspace = await createE2EWorkspace()
  const app = await electron.launch({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await window.locator('[data-window-control="toggle-maximize"]').click()
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized())).toBe(true)
    await expect(window.locator('[data-window-control="toggle-maximize"]')).toHaveAttribute('aria-label', '还原窗口')

    await window.locator('[data-window-control="toggle-maximize"]').click()
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized())).toBe(false)

    await window.locator('[data-window-control="minimize"]').click()
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())).toBe(true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.restore())

    await window.locator('[data-window-control="close"]').click()
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.show()
      BrowserWindow.getAllWindows()[0]?.focus()
    })
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('opens the packaged Windows executable', async () => {
  test.skip(process.platform !== 'win32', 'Windows package only')
  const workspace = await createE2EWorkspace()
  const executablePath = process.env.MINERU_E2E_EXECUTABLE_PATH
    ?? join(__dirname, `../../release/${releaseName}/MinerU.exe`)
  const app = await electron.launch({ executablePath, args: [], env: workspace.env })
  try {
    const window = await app.firstWindow()
    const settingsResult = await window.evaluate(async () => {
      try {
        return { ok: true, value: await window.mineru.getSettings() }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    })
    expect(settingsResult, JSON.stringify(settingsResult)).toMatchObject({ ok: true })
    await expect(window.getByRole('button', { name: '选择 PDF' })).toBeVisible()
    await expect(window.getByTestId('particle-lake')).toHaveAttribute('data-renderer', 'webgl2')
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})
