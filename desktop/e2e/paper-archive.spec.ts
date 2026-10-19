import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { createE2EWorkspace, launchElectron, seedReaderTask } from './helpers'

for (const disableWebGL of [false, true]) {
  test(`paper archive search, navigation and reader return${disableWebGL ? ' without WebGL' : ''}`, async ({}, testInfo) => {
    // This case seeds 37 papers and drives the 3D archive. Hosted Windows has no GPU: the archive is
    // rasterised in software at 1-3 fps and an expanded-detail frame takes 10 s or more, so there the
    // case runs with reduced motion (see `animated` below); GPU machines keep the full animation.
    if (!disableWebGL) test.setTimeout(180_000)
    const workspace = await createE2EWorkspace()
    let app: Awaited<ReturnType<typeof launchElectron>> | null = null
    try {
      for (let index = 0; index < 37; index++) {
        await seedReaderTask(workspace, {
          taskId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          createdAt: '2026-10-07T12:00:00Z',
          englishTitle: index === 36 ? 'Archive Alpha' : `Archive Paper ${index}`
        })
      }
      app = await launchElectron({
        args: [join(__dirname, '../out/main/index.js')],
        env: workspace.env
      })
      const window = await app.firstWindow()
      await expect.poll(() => window.evaluate(() => typeof window.copilotix?.paperInsight?.get)).toBe('function')
      // Software rendering (no GPU) runs the case with reduced motion: assertions are shared except
      // the extraction-timing steps below, which only exist while the animation is running.
      const animated = disableWebGL || !SOFTWARE_RENDERER.test(await window.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2')
        const info = gl?.getExtension('WEBGL_debug_renderer_info')
        return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
      }))
      if (!animated) {
        await window.emulateMedia({ reducedMotion: 'reduce' })
        testInfo.annotations.push({ type: 'software renderer', description: 'Reduced motion; the animated extraction and return are covered on GPU machines only.' })
      }
      // Navigation covers the saved legacy archive path; provider generation has
      // its own HTTP/storage acceptance case. Completed analysis unlocks detail.
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('paperInsight:get')
        ipcMain.handle('paperInsight:get', () => ({ ok: true, value: {
          status: 'ready', stale: false, insight: {
            summary: 'Archive fixture', researchQuestion: 'Archive navigation', method: 'Saved analysis',
            contributions: [], findings: [], limitations: [], keywords: [],
            model: { provider: 'deepseek', name: 'deepseek-flash' },
            generatedAt: '2026-10-07T12:00:00Z', sourceRevision: 'fixture'
          }
        } }))
      })
      if (disableWebGL) {
        // Electron builds may ignore Chromium's --disable-webgl switch. Deny only WebGL
        // contexts in this isolated renderer, leaving the reader's 2D canvas operational.
        await window.evaluate(() => {
          const original = HTMLCanvasElement.prototype.getContext
          Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
            configurable: true,
            value: function (this: HTMLCanvasElement, kind: string, ...args: unknown[]) {
              return kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl'
                ? null : Reflect.apply(original, this, [kind, ...args])
            }
          })
        })
      }
      await window.locator('[data-edge-dock="top"]').hover()
      const navigation = window.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /文库$/u })
      await expect(navigation).toBeVisible()
      await navigation.click()
      const archive = window.getByRole('region', { name: '文库', exact: true })
      const fallback = archive.getByRole('heading', { name: '当前环境无法显示三维文库' })
      const canvas = archive.locator('canvas.paper-archive-canvas[data-archive-state="ready"]')
      // A canvas alone does not prove that the model loaded. Accept only ready or explicit fallback.
      await expect(canvas.or(fallback)).toBeVisible({ timeout: 15_000 })
      if (disableWebGL) await expect(fallback).toBeVisible()
      const supported = !await fallback.isVisible()
      await expect(archive.getByRole('checkbox', { name: '流畅模式' })).toHaveCount(0)
      if (supported) {
        await expect(archive.getByText('COLUMN 01 / 01', { exact: true })).toBeVisible()
        await archive.focus()
        await window.keyboard.press('ArrowRight')
        await expect(archive.getByText('COLUMN 01 / 01', { exact: true })).toBeVisible()
        await window.keyboard.press('ArrowLeft')
        await expect(archive.getByText('COLUMN 01 / 01', { exact: true })).toBeVisible()
        const index = archive.locator('.paper-archive-index strong')
        const first = await index.innerText()
        await archive.focus()
        await window.keyboard.press('ArrowDown')
        await expect(index).not.toHaveText(first)
        await window.keyboard.press('ArrowUp')
        await expect(index).toHaveText(first)
        const performance = await measureArchivePerformance(window, animated)
        const performancePath = testInfo.outputPath('archive-performance.json')
        await writeFile(performancePath, JSON.stringify(performance, null, 2))
        await testInfo.attach('archive-performance.json', { path: performancePath, contentType: 'application/json' })
      } else {
        testInfo.annotations.push({ type: 'WebGL fallback', description: '3D navigation and performance assertions are unavailable; search and reader return still run.' })
      }

      await archive.focus()
      await window.keyboard.press('/')
      const search = archive.getByRole('searchbox', { name: '搜索文库' })
      await expect(search).toBeFocused()
      await search.fill('no-such-archive-paper')
      await expect(archive.getByText('没有匹配的论文')).toBeVisible()
      await search.fill('ARCHIVE alpha')
      const results = archive.getByRole('list', { name: '搜索结果' })
      await expect(results.getByRole('button')).toHaveCount(1)
      await results.getByRole('button', { name: /Archive Alpha/u }).click()
      if (supported) {
        await expect(archive.locator('.paper-archive-title')).toHaveText('Archive Alpha')
        await expect(archive.getByRole('button', { name: '查看档案' })).toBeEnabled({ timeout: 30_000 })
        await archive.focus()
        // A held Enter repeats; only the first press may open the detail, never the reader.
        await window.keyboard.down('Enter')
        await window.keyboard.down('Enter')
        await window.keyboard.up('Enter')
        // While extracting, a further Enter is ignored. Reduced motion opens at once, where a second
        // Enter would rightly open the reader, so it is pressed only during the animation.
        if (animated) await window.keyboard.press('Enter')
        await expect(window.locator('.reader-header')).toHaveCount(0)
        if (animated) {
          // Escape during extraction, then reopen during the short return. The return lasts about
          // 320 ms of wall time, so record the layer's state at every change while it is closing
          // instead of sampling once after it may already have finished.
          await archive.evaluate((root) => {
            const record: boolean[] = []
            Reflect.set(window, '__closingLayerInert', record)
            new MutationObserver(() => {
              if (root.getAttribute('data-detail-phase') !== 'closing') return
              const layer = root.querySelector('.paper-archive-detail-layer')
              if (layer) record.push(layer.hasAttribute('inert'))
            }).observe(root, { attributes: true, childList: true, subtree: true })
          })
          await window.keyboard.press('Escape')
          await expect.poll(() => window.evaluate(() => (Reflect.get(window, '__closingLayerInert') as boolean[]).length)).toBeGreaterThan(0)
          expect(await window.evaluate(() => (Reflect.get(window, '__closingLayerInert') as boolean[]).every(Boolean))).toBe(true)
        } else {
          // Reduced motion closes without a return animation.
          await window.keyboard.press('Escape')
          await expect(archive).toHaveAttribute('data-detail-phase', 'closed')
        }
        await window.keyboard.press('Enter')
        await expect(archive).toHaveAttribute('data-detail-phase', 'open', { timeout: 20_000 })
        const abstract = archive.getByRole('tab', { name: /摘要/u })
        const structure = archive.getByRole('tab', { name: /结构/u })
        await abstract.focus()
        await window.keyboard.press('ArrowRight')
        await expect(structure).toBeFocused()
        await expect(structure).toHaveAttribute('aria-selected', 'true')
        await window.keyboard.press('Home')
        await expect(abstract).toBeFocused()
        await archive.getByRole('tabpanel').focus()
        await window.keyboard.press('ArrowDown')
        await expect(archive).toHaveAttribute('data-detail-phase', 'open')
        // Drag in the model area must neither open the reader nor dismiss detail.
        const box = await canvas.boundingBox()
        expect(box).not.toBeNull()
        const x = box!.x + box!.width * 0.28
        const y = box!.y + box!.height * 0.55
        await window.mouse.move(x, y)
        await window.mouse.down()
        await window.mouse.move(x + 60, y + 20, { steps: 5 })
        await window.mouse.up()
        await expect(archive).toHaveAttribute('data-detail-phase', 'open')
        await expect(window.locator('.reader-header')).toHaveCount(0)
        // Detail keeps search collapsed and inert; Escape returns focus to the archive.
        await window.keyboard.press('/')
        await expect(archive.locator('.paper-archive-tools')).toHaveAttribute('inert', '')
        await expect(archive.locator('#paper-archive-search')).not.toBeFocused()
        await expect(results).toHaveCount(0)
        await expect(archive).toHaveAttribute('data-detail-phase', 'open')
        await window.keyboard.press('Escape')
        await expect(archive).toHaveAttribute('data-detail-phase', 'closed')
        await expect(archive).toBeFocused()
        await window.keyboard.press('ArrowDown')
        await window.keyboard.press('ArrowDown')
        await expect(archive).toHaveAttribute('data-detail-phase', 'closed')
        await window.keyboard.press('/')
        await search.fill('ARCHIVE alpha')
        await window.keyboard.press('Enter')
        await expect(archive.locator('.paper-archive-title')).toHaveText('Archive Alpha')
        await expect(archive.getByRole('button', { name: '查看档案' })).toBeEnabled({ timeout: 30_000 })
        await window.keyboard.press('Enter')
        await expect(archive.getByRole('button', { name: '打开阅读' })).toBeVisible()
        // Explicit Open remains a shortcut, including during extraction.
        await archive.getByRole('button', { name: '打开阅读' }).click()
      }
      await expect(window.locator('.reader-header')).toBeVisible({ timeout: 30_000 })
      await expect(window.locator('.reader-title')).toHaveText('Archive Alpha')
      const markdown = window.locator('.reader-tab-panel.active .markdown-scroll')
      await expect(markdown).toHaveAttribute('data-render-state', /^(ready|error)$/, { timeout: 31_000 })
      await expect(markdown).toHaveAttribute('data-render-state', 'ready')
      await window.locator('.reader-header button').first().click()
      await expect(archive).toBeVisible()
      if (supported) {
        await expect(archive.locator('.paper-archive-title')).toHaveText('Archive Alpha')
      } else {
        await expect(fallback).toBeVisible()
        await expect(search).toBeVisible()
      }
    } finally {
      await app?.close()
      await workspace.cleanup()
    }
  })
}

const SOFTWARE_RENDERER = /Microsoft Basic Render|SwiftShader|llvmpipe|Software/iu

/** Scene renders since the counter was installed (each render clears the canvas). */
async function sceneRenders(window: Page): Promise<number> {
  return window.evaluate(() => {
    const proto = WebGL2RenderingContext.prototype as unknown as { clear(mask: number): void; __counted?: boolean }
    if (!proto.__counted) {
      proto.__counted = true
      const clear = proto.clear
      proto.clear = function (this: WebGL2RenderingContext, mask: number) {
        Reflect.set(window, '__sceneClears', (Number(Reflect.get(window, '__sceneClears')) || 0) + 1)
        clear.call(this, mask)
      }
    }
    return Number(Reflect.get(window, '__sceneClears')) || 0
  })
}

async function measureArchivePerformance(window: Page, animated: boolean): Promise<object> {
  await window.keyboard.press('Control+Shift+F')
  const stats = window.locator('.paper-archive-stats')
  await expect(stats).toBeVisible()
  const read = async (): Promise<{ fps: number; triangles: number; text: string }> => {
    const text = await stats.innerText()
    const match = /^(\d+) fps.*?([\d.]+)M 三角形/u.exec(text)
    expect(match, text).not.toBeNull()
    return { fps: Number(match![1]), triangles: Number(match![2]) * 1e6, text }
  }
  const keys = []
  const keyRendersBefore = await sceneRenders(window)
  for (let index = 0; index < 24; index++) {
    await window.keyboard.press('ArrowDown')
    await window.waitForTimeout(125)
    if (index >= 12 && index % 4 === 0) keys.push(await read())
  }
  // Without a GPU the case runs with reduced motion: the scene settles at once and a per-second fps
  // sample can rightly read 0, so require that navigation rendered at all. GPUs keep the 30 fps target.
  if (!animated) expect(await sceneRenders(window) - keyRendersBefore).toBeGreaterThan(0)
  for (const sample of keys) {
    if (animated) expect(sample.fps, sample.text).toBeGreaterThanOrEqual(SOFTWARE_RENDERER.test(sample.text) ? 1 : 30)
    expect(sample.fps, sample.text).toBeLessThanOrEqual(70)
    expect(sample.triangles, sample.text).toBeLessThanOrEqual(3_000_000)
  }
  const box = await window.locator('.paper-archive-canvas').boundingBox()
  expect(box).not.toBeNull()
  const x = box!.x + box!.width * 0.25
  const y = box!.y + box!.height * 0.55
  await window.mouse.move(x, y)
  const dragRendersBefore = await sceneRenders(window)
  await window.mouse.down()
  const drag = []
  try {
    for (let index = 0; index < 24; index++) {
      await window.mouse.move(x + Math.sin(index / 3) * 100, y + Math.cos(index / 3) * 40)
      await window.waitForTimeout(125)
      if (index >= 12 && index % 4 === 0) drag.push(await read())
    }
  } finally {
    await window.mouse.up()
  }
  if (!animated) expect(await sceneRenders(window) - dragRendersBefore).toBeGreaterThan(0)
  for (const sample of drag) {
    if (animated) expect(sample.fps, sample.text).toBeGreaterThan(0)
    expect(sample.fps, sample.text).toBeLessThanOrEqual(70)
    expect(sample.triangles, sample.text).toBeLessThanOrEqual(3_000_000)
  }
  await window.keyboard.press('Control+Shift+F')
  return { keys, drag }
}
