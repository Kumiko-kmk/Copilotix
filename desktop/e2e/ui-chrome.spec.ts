import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createE2EWorkspace, launchElectron, seedReaderTask } from './helpers'

test('keeps hover chrome inside the minimum supported window size', async () => {
  const workspace = await createE2EWorkspace()
  await seedReaderTask(workspace)
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = 'light'
      BrowserWindow.getAllWindows()[0]?.setSize(1100, 700)
    })
    await window.emulateMedia({ colorScheme: 'light' })
    const viewport = await window.evaluate(() => [innerWidth, innerHeight] as const)
    expect(viewport[0]).toBeGreaterThanOrEqual(1100)
    expect(viewport[0]).toBeLessThanOrEqual(1102)
    expect(viewport[1]).toBeGreaterThanOrEqual(700)
    expect(viewport[1]).toBeLessThanOrEqual(702)

    const mainBounds = await window.locator('.main-surface').boundingBox()
    expect(mainBounds).not.toBeNull()
    expect(mainBounds!.x).toBeCloseTo(1, 0)
    expect(mainBounds!.y).toBeCloseTo(40, 0)
    expect(mainBounds!.x + mainBounds!.width).toBeCloseTo(viewport[0] - 1, 0)
    expect(mainBounds!.y + mainBounds!.height).toBeCloseTo(viewport[1] - 1, 0)
    await expect(window.locator('.app-shell')).toHaveCSS('border-radius', '16px')
    await expect(window.locator('.app-shell')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(window.locator('.main-surface')).toHaveCSS('border-radius', '0px')
    await expect(window.locator('.main-surface')).toHaveCSS('background-color', 'rgb(247, 242, 232)')
    const closeControl = window.locator('[data-window-control="close"]')
    await expect(closeControl).toHaveCSS('width', '12px')
    await expect(closeControl).toHaveCSS('height', '12px')
    const closeBounds = await closeControl.boundingBox()
    expect(closeBounds).not.toBeNull()
    expect(closeBounds!.y).toBeGreaterThanOrEqual(14)
    expect(closeBounds!.y + closeBounds!.height).toBeLessThanOrEqual(27)

    await window.locator('[data-edge-dock="top"]').hover()
    await window.waitForTimeout(300)
    const topBounds = await window.locator('[data-edge-dock="top"] .edge-dock-panel').boundingBox()
    expect(topBounds).not.toBeNull()
    expect(topBounds!.x).toBeGreaterThanOrEqual(0)
    expect(topBounds!.x + topBounds!.width).toBeLessThanOrEqual(viewport[0])
    await capture(window, 'chrome-1100x700-light-top.png')

    await window.locator('[data-edge-dock="bottom"]').hover()
    await window.waitForTimeout(500)
    const bottomBounds = await window.locator('[data-edge-dock="bottom"] .edge-dock-panel').boundingBox()
    expect(bottomBounds).not.toBeNull()
    expect(bottomBounds!.y + bottomBounds!.height).toBeLessThanOrEqual(viewport[1])
    await window.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => window.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true)
    await expect(window.locator('.app-shell')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(window.locator('.main-surface')).toHaveCSS('background-color', 'rgb(247, 242, 232)')
    await capture(window, 'chrome-1100x700-fixed-light-bottom.png')
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('keeps the new parse page static across supported sizes and themes', async () => {
  const workspace = await createE2EWorkspace()
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    const uploadEntry = window.getByTestId('pdf-upload-entry')

    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = 'light'
      BrowserWindow.getAllWindows()[0]?.setSize(1100, 700)
    })
    await window.waitForTimeout(300)
    const compactViewport = await window.evaluate(() => [innerWidth, innerHeight] as const)
    expect(compactViewport[0]).toBeGreaterThanOrEqual(1100)
    expect(compactViewport[0]).toBeLessThanOrEqual(1102)
    expect(compactViewport[1]).toBeGreaterThanOrEqual(700)
    expect(compactViewport[1]).toBeLessThanOrEqual(702)
    await expect(window.locator('.new-parse-page canvas')).toHaveCount(0)
    await expect(uploadEntry).toHaveCSS('background-color', 'rgb(247, 242, 232)')
    await expect(uploadEntry).toHaveCSS('backdrop-filter', 'none')
    await capture(window, 'new-parse-1100x700-static.png')

    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = 'dark'
      BrowserWindow.getAllWindows()[0]?.setSize(1440, 900)
    })
    await window.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => window.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true)
    await window.waitForTimeout(300)
    const spaciousViewport = await window.evaluate(() => [innerWidth, innerHeight] as const)
    expect(spaciousViewport[0]).toBeGreaterThanOrEqual(1440)
    expect(spaciousViewport[0]).toBeLessThanOrEqual(1442)
    expect(spaciousViewport[1]).toBeGreaterThanOrEqual(900)
    expect(spaciousViewport[1]).toBeLessThanOrEqual(902)
    await expect(window.locator('.new-parse-page canvas')).toHaveCount(0)
    await expect(window.locator('.app-shell')).toHaveCSS('border-radius', '16px')
    await expect(window.locator('.main-surface')).toHaveCSS('border-radius', '0px')
    await expect(window.locator('.main-surface')).toHaveCSS('background-color', 'rgb(247, 242, 232)')
    await capture(window, 'new-parse-1440x900-static.png')
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

async function capture(window: import('@playwright/test').Page, filename: string): Promise<void> {
  const directory = process.env.MINERU_E2E_UI_SCREENSHOTS
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  await window.screenshot({ path: join(directory, filename) })
}
