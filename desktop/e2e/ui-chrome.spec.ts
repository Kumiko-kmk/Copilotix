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
    await expect(window.locator('[data-window-control="close"]')).toHaveCSS('width', '15px')
    await expect(window.locator('[data-window-control="close"]')).toHaveCSS('height', '15px')

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

test('keeps the particle lake legible across supported sizes and themes', async () => {
  const workspace = await createE2EWorkspace()
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    const particleLake = window.getByTestId('particle-lake')
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
    await expect(particleLake).toHaveAttribute('data-renderer', 'webgl2')
    await expect(particleLake).toHaveAttribute('data-render-state', 'animated')
    await expect.poll(() => particleLake.getAttribute('data-particle-count').then(Number)).toBeGreaterThanOrEqual(120_000)
    const compactRidgeCount = Number(await particleLake.getAttribute('data-ridge-count'))
    expect(compactRidgeCount).toBeGreaterThanOrEqual(7)
    await expect(uploadEntry).toHaveCSS('backdrop-filter', /blur\(18px\)/)
    await capture(window, 'new-parse-1100x700-light.png')

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
    await expect.poll(() => particleLake.getAttribute('data-particle-count').then(Number)).toBeGreaterThanOrEqual(200_000)
    const spaciousRidgeCount = Number(await particleLake.getAttribute('data-ridge-count'))
    expect(spaciousRidgeCount).toBeGreaterThan(compactRidgeCount)
    const firstMotionSample = await particleLake.getAttribute('data-motion-sample')
    const firstWaveSample = await particleLake.getAttribute('data-wave-sample')
    expect(firstMotionSample).toBeTruthy()
    expect(firstWaveSample).toBeTruthy()
    await expect.poll(() => particleLake.getAttribute('data-motion-sample')).not.toBe(firstMotionSample)
    await expect.poll(() => particleLake.getAttribute('data-wave-sample')).not.toBe(firstWaveSample)
    const tangentSample = (await particleLake.getAttribute('data-tangent-sample'))!.split(',').map(Number)
    const [tangentX, tangentY, normalX, normalY] = tangentSample
    expect(Math.hypot(tangentX ?? 0, tangentY ?? 0)).toBeCloseTo(1, 2)
    expect(Math.hypot(normalX ?? 0, normalY ?? 0)).toBeCloseTo(1, 2)
    expect(Math.abs((tangentX ?? 0) * (normalX ?? 0) + (tangentY ?? 0) * (normalY ?? 0))).toBeLessThan(0.01)
    const depthProfile = (await particleLake.getAttribute('data-depth-profile'))!.split(',').map(Number)
    expect(depthProfile[1]).toBeGreaterThan(depthProfile[0] ?? 0)
    expect(depthProfile[2]).toBeGreaterThan(depthProfile[0] ?? 0)
    await expect.poll(() => particleLake.getAttribute('data-average-frame-ms').then(Number), { timeout: 10_000 }).toBeLessThan(22)
    await expect(window.locator('.app-shell')).toHaveCSS('border-radius', '16px')
    await expect(window.locator('.main-surface')).toHaveCSS('border-radius', '0px')
    await expect(window.locator('.main-surface')).toHaveCSS('background-color', 'rgb(247, 242, 232)')
    await capture(window, 'new-parse-1440x900-fixed-light.png')

    await window.emulateMedia({ reducedMotion: 'reduce' })
    await expect(particleLake).toHaveAttribute('data-render-state', 'static')
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
