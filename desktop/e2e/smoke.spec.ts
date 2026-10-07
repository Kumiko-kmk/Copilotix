import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PACKAGED_SMOKE_ARG, validatePackagedSmokeOutput } from '../src/shared/packagedSmoke.mjs'
import { createE2EWorkspace, launchElectron } from './helpers'
import { MAX_PDF_PAGES } from '../src/shared/constants'

const desktopPackage = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as {
  version: string
  devDependencies: { electron: string }
}

test('opens the minimal new parse page', async () => {
  const workspace = await createE2EWorkspace()
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await expect(window.locator('.tutorial-page')).toBeVisible()
    const navigationTrigger = window.locator('[data-edge-dock="top"] .edge-dock-trigger')
    await navigationTrigger.focus()
    await expect(navigationTrigger).toHaveAttribute('aria-expanded', 'true')
    const newParse = window.locator('.top-navigation-item').filter({ hasText: '新解析' })
    await expect(newParse).toBeVisible()
    await newParse.focus()
    await newParse.press('Enter')
    await expect(window.locator('aside[aria-label="主导航"]')).toHaveCount(0)
    await expect(window.getByRole('group', { name: '窗口控制' })).toBeVisible()
    await expect(window.locator('.titlebar-brand')).toHaveCount(0)
    expect(await window.title()).toBe('')
    await window.locator('[data-edge-dock="top"]').hover()
    await expect(window.getByRole('button', { name: '任务管理' })).toBeVisible()
    await expect(window.getByText('智能解析')).toHaveCount(0)
    await expect(window.getByText('拖入文档')).toBeVisible()
    await expect(window.getByText(`当前支持 PDF，单篇最多 ${MAX_PDF_PAGES} 页`)).toBeVisible()
    await expect(window.getByRole('button', { name: '选择文档' })).toBeVisible()
    const uploadEntry = window.getByTestId('pdf-upload-entry')
    await expect(uploadEntry).toBeVisible()
    await expect(uploadEntry).toHaveCSS('border-radius', '20px')
    await expect(uploadEntry).toHaveCSS('border-style', 'solid')
    await expect(window.locator('.new-parse-page canvas')).toHaveCount(0)
    await window.getByRole('button', { name: '任务管理' }).click()
    await expect(window.locator('.titlebar-brand')).toHaveText('COPILOTIX')
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('supports the custom traffic-light window controls', async () => {
  const workspace = await createE2EWorkspace()
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
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

test('starts the hardened packaged Windows core without a Node inspector', async () => {
  test.skip(process.platform !== 'win32', 'Windows package only')
  const advancedDirectory = join(__dirname, '../../release/advanced')
  const executablePath = process.env.COPILOTIX_E2E_EXECUTABLE_PATH ?? (() => {
    const manifest = JSON.parse(readFileSync(join(advancedDirectory, 'release-manifest.json'), 'utf8')) as {
      schemaVersion: number
      artifactDirectory?: string
      runtimeArtifactDirectory?: string
      runtime: { entryPoint: string }
    }
    if (manifest.schemaVersion >= 5 && manifest.runtimeArtifactDirectory) {
      return join(advancedDirectory, '..', manifest.runtimeArtifactDirectory, 'Copilotix.exe')
    }
    const runtimeBase = manifest.schemaVersion >= 4
      ? join(advancedDirectory, '..')
      : manifest.artifactDirectory ? join(advancedDirectory, '..', manifest.artifactDirectory) : advancedDirectory
    return join(runtimeBase, manifest.runtime.entryPoint)
  })()
  // Playwright Electron.launch requires a Node inspector, intentionally fused
  // off in release binaries. Exercise the isolated packaged smoke entry instead.
  const result = await promisify(execFile)(executablePath, [PACKAGED_SMOKE_ARG], {
    cwd: dirname(executablePath), windowsHide: true, timeout: 30_000
  })
  expect(validatePackagedSmokeOutput(result, {
    appVersion: desktopPackage.version,
    electronVersion: desktopPackage.devDependencies.electron
  })).toBe(true)
})
