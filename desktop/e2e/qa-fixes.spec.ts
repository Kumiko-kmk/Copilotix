import { expect, test, type Page } from '@playwright/test'
import { copyFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createE2EWorkspace, launchElectron, openPaperFromHome, seedReaderTask } from './helpers'

async function navigate(page: Page, name: string) {
  await page.locator('[data-edge-dock="top"]').hover()
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: new RegExp(`${name}$`, 'u') }).click()
  await page.mouse.move(200, 200)
}

test('long paper titles keep every reader action inside the minimum window', async () => {
  const workspace = await createE2EWorkspace()
  const documentId = await seedReaderTask(workspace, { englishTitle: 'DeepONet: Learning nonlinear operators for identifying differential equations based on the universal approximation theorem of operators for scientific machine learning' })
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1100, 700))
    const page = await app.firstWindow()
    await openPaperFromHome(page, documentId)
    await expect(page.locator('.reader-header')).toBeVisible()
    const metrics = await page.locator('.reader-header').evaluate(header => ({
      viewport: innerWidth, scrollWidth: header.scrollWidth, width: header.clientWidth,
      buttons: [...header.querySelectorAll('button')].map(button => ({ label: button.getAttribute('aria-label'), left: button.getBoundingClientRect().left, right: button.getBoundingClientRect().right }))
    }))
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width + 1)
    for (const button of metrics.buttons) { expect(button.left).toBeGreaterThanOrEqual(0); expect(button.right).toBeLessThanOrEqual(metrics.viewport) }
    await page.getByRole('button', { name: '删除论文', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '删除论文' })).toBeVisible()
    await page.keyboard.press('Escape')
  } finally { await app.close(); await workspace.cleanup() }
})

test('settings navigation confirms discard, stay, successful save and failed save', async () => {
  const workspace = await createE2EWorkspace()
  await seedReaderTask(workspace)
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const page = await app.firstWindow()
    await navigate(page, '设置'); await page.getByRole('button', { name: /模型设置/u }).click()
    const provider = page.getByRole('checkbox').first()
    await provider.uncheck(); await navigate(page, '新解析')
    await page.getByRole('button', { name: '继续编辑', exact: true }).click(); await expect(provider).not.toBeChecked()
    await navigate(page, '新解析'); await page.getByRole('button', { name: '放弃并离开', exact: true }).click()
    await expect(page.locator('.new-parse-page')).toBeVisible()
    await navigate(page, '设置'); await page.getByRole('button', { name: /模型设置/u }).click(); await expect(provider).toBeChecked()
    await provider.uncheck(); await navigate(page, '新解析'); await page.getByRole('button', { name: '保存并离开', exact: true }).click()
    await expect(page.locator('.new-parse-page')).toBeVisible()
    await navigate(page, '设置'); await page.getByRole('button', { name: /模型设置/u }).click(); await expect(provider).not.toBeChecked()
    await provider.check()
    // Reject only this isolated instance's save at the real Main IPC boundary.
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('settings:save'); ipcMain.handle('settings:save', () => { throw new Error('QA simulated save failure') }) })
    await navigate(page, '新解析'); await page.getByRole('button', { name: '保存并离开', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '有未保存的设置' })).toBeHidden()
    await expect(page.locator('.settings-page')).toBeVisible(); await expect(provider).toBeChecked()
    await expect(page.getByText('有未保存的更改')).toBeVisible()
  } finally { await app.close(); await workspace.cleanup() }
})

test('failed papers show a readable error and WebGL fallback still opens the reader', async () => {
  const workspace = await createE2EWorkspace()
  const documentId = await seedReaderTask(workspace, { missingPdf: true, sourceMarkdown: '' })
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const page = await app.firstWindow(); await openPaperFromHome(page, documentId)
    await expect(page.getByRole('alert')).toContainText('原文未生成，文档处理失败')
    await expect(page.getByRole('button', { name: '重试文档处理', exact: true })).toBeVisible()
    await navigate(page, '新解析')
    await page.evaluate(() => { const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (...args: Parameters<typeof original>) { return /^webgl/u.test(String(args[0])) ? null : original.apply(this, args) } as typeof original })
    await navigate(page, '文库')
    await expect(page.getByText('当前环境无法显示三维文库')).toBeVisible()
    await expect(page.getByText(/可以使用右上角搜索/u)).not.toContainText('任务管理')
    await page.getByRole('searchbox', { name: '搜索文库' }).fill('missing')
    await page.keyboard.press('Enter'); await expect(page.locator('.reader-header')).toBeVisible()
  } finally { await app.close(); await workspace.cleanup() }
})

test('import rejects empty and disguised PDFs, retains valid files in a mixed batch and reuses tutorial credentials', async () => {
  const workspace = await createE2EWorkspace()
  await seedReaderTask(workspace)
  const empty = join(workspace.root, 'empty.pdf'); const invalid = join(workspace.root, 'invalid.pdf'); const valid = join(workspace.root, 'valid.pdf')
  await writeFile(empty, ''); await writeFile(invalid, 'Not a PDF'); await copyFile(join(__dirname, '../resources/tutorial/Attention Is All You Need.pdf'), valid)
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ net }) => { net.fetch = async (url) => String(url).includes('/api/v4/extract-results/batch/')
      ? new Response(JSON.stringify({ code: 0, data: { extract_result: [] } }), { status: 200 })
      : new Response(JSON.stringify({ code: 'QA_OFFLINE', msg: 'QA simulated parser failure' }), { status: 400 }) })
    const settings = await page.evaluate(() => window.copilotix.getSettings())
    const { credentials: _credentials, ...update } = settings
    await page.evaluate(update => window.copilotix.saveSettings(update), { ...update, outputRoot: workspace.root, credentialMutations: { parser: { action: 'set' as const, value: 'qa-isolated-parser-token' } } })
    await page.reload(); await expect(page.locator('.new-parse-page')).toBeVisible()
    await navigate(page, '新手教程'); await expect(page.getByRole('button', { name: '选择文档', exact: true })).toBeEnabled()
    await navigate(page, '新解析')
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }) }, [empty, invalid, valid])
    await page.locator('input[type="file"]').setInputFiles([empty, invalid, valid]); await page.getByRole('button', { name: '开始解析', exact: true }).click()
    await expect(page.locator('.ant-message')).toContainText('2 个 PDF 未导入')
    await expect.poll(async () => (await page.evaluate(() => window.copilotix.listDocuments())).length).toBe(2)
    const docs = await page.evaluate(() => window.copilotix.listDocuments())
    expect(docs.some(doc => doc.originalName === 'valid.pdf')).toBe(true)
    expect(docs.some(doc => doc.originalName === 'empty.pdf' || doc.originalName === 'invalid.pdf')).toBe(false)
  } finally { await app.close(); await workspace.cleanup() }
})
