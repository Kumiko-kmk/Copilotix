import { expect, test } from '@playwright/test'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createE2EWorkspace, launchElectron, openPaperFromLibrary, seedReaderTask } from './helpers'

test('renders every row of a compound figure and reveals its hidden PDF from a maximized reader', async () => {
  const workspace = await createE2EWorkspace()
  const fixture = join(workspace.root, 'compound-figure.pdf')
  await mkdir(join(fixture, 'images'), { recursive: true })
  const colors = [[0.9, 0.2, 0.2], [0.2, 0.7, 0.2], [0.2, 0.3, 0.9],
    [0.8, 0.6, 0.2], [0.7, 0.2, 0.7], [0.2, 0.7, 0.8]]
  const panels = colors.map((color, i) => ({ color, x: i % 2 ? 300 : 60, y: 100 + Math.floor(i / 2) * 130, name: 'panel-' + i + '.png' }))
  const caption = 'Figure 1: All six panels. Complete caption.'
  const images = panels.map(p => '![](images/' + p.name + ')')
  const sourceImages = images.map((image, i) => i === 0 ? image + '  \nControl; Treatment' : image)
  const translatedImages = images.map((image, i) => i === 0 ? image + '  \n对照组；治疗组' : image)
  const source = ['# Compound figure', ...sourceImages.slice(0, 4), caption, ...sourceImages.slice(4)].join('\n\n')
  const translated = ['# 多行整图', ...translatedImages.slice(0, 4), '图 1：全部六张子图。\n\n保留完整第二段图说。', ...translatedImages.slice(4)].join('\n\n')
  const layout = { pdf_info: [{ page_idx: 0, page_size: [612, 792], para_blocks: [
    { index: -1, type: 'title', bbox: [60, 20, 520, 45], text: 'Compound figure' },
    ...panels.map((p, i) => ({ index: i < 4 ? i : i + 1, type: i % 2 ? 'image' : 'chart',
      bbox: [p.x, p.y, p.x + 220, p.y + 110], lines: [{ spans: [{ image_path: 'images/' + p.name }] }] })),
    { index: 4, type: 'image_caption', bbox: [60, 490, 520, 525], text: caption },
    { index: 8, type: 'image_footnote', bbox: [60, 474, 280, 484], text: 'Control; Treatment' }
  ] }] }
  await Promise.all([
    writeFile(join(fixture, 'original.pdf'), figurePdf(panels)),
    writeFile(join(fixture, 'layout.json'), JSON.stringify(layout)),
    writeFile(join(fixture, 'full.md'), source),
    writeFile(join(fixture, 'full.zh-CN.md'), translated),
    ...panels.map(p => copyFile(join(__dirname, '../resources/icon.png'), join(fixture, 'images', p.name)))
  ])
  const documentId = await seedReaderTask(workspace, { sourceTaskDir: fixture })
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await openPaperFromLibrary(window, documentId)
    await expect(window.locator('.reader-header')).toBeVisible({ timeout: 30_000 })
    await window.keyboard.press('Control+2')
    let pane = window.locator('.reader-tab-panel.active').filter({ has: window.locator('.markdown-pane') }).first()
    await expect(pane.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready')
    await expect(pane.locator('.reader-figure-snapshot[data-rendered="true"]')).toHaveCount(1)
    await expect(pane.locator('article img')).toHaveCount(0)
    await expect(pane.getByText('Control; Treatment', { exact: true })).toBeHidden()
    // These six colors are in the original PDF, not in the extracted icon
    // assets. Sampling every row detects a crop that includes only one row.
    const pixels = await pane.locator('.reader-figure-snapshot-canvas').evaluate((element, centers) => {
      const canvas = element as HTMLCanvasElement
      const context = canvas.getContext('2d')!
      return centers.map(p => Array.from(context.getImageData(
        Math.floor((p.x + 110 - 56) / 468 * canvas.width),
        Math.floor((p.y + 55 - 96) / 392 * canvas.height), 1, 1).data).slice(0, 3))
    }, panels)
    pixels.forEach((pixel, i) => pixel.forEach((channel, j) => expect(Math.abs(channel - colors[i]![j]! * 255)).toBeLessThan(3)))
    const originalCanvas = await pane.locator('.reader-figure-snapshot-canvas').evaluate(element => (element as HTMLCanvasElement).toDataURL())
    await window.keyboard.press('Control+3')
    pane = window.locator('.reader-tab-panel.active').filter({ has: window.locator('.markdown-pane') }).first()
    await expect(pane.locator('.reader-figure-snapshot[data-rendered="true"]')).toHaveCount(1)
    await expect(pane.locator('article img')).toHaveCount(0)
    await expect(pane.locator('article')).toContainText('保留完整第二段图说。')
    await expect(pane.getByText('对照组；治疗组', { exact: true })).toBeHidden()
    expect(await pane.locator('.reader-figure-snapshot-canvas').evaluate(element => (element as HTMLCanvasElement).toDataURL())).toBe(originalCanvas)
    await window.keyboard.press('Control+1')
    await window.keyboard.press('Control+w')
    await window.keyboard.press('Control+3')
    await window.keyboard.press('Control+Shift+m')
    await expect(window.locator('.reader-workbench.has-maximized')).toBeVisible()
    await pane.getByRole('button', { name: '查看 PDF 第 1 页整图' }).click()
    await expect(window.locator('.reader-workbench.has-maximized')).toHaveCount(0)
    await expect(window.locator('.reader-pdf-panel:visible')).toBeVisible()
    await expect(window.locator('[data-pdf-page="0"] canvas')).toBeVisible()
  } finally { await app.close(); await workspace.cleanup() }
})

function figurePdf(panels: Array<{ color: number[]; x: number; y: number }>): Buffer {
  const stream = panels.map((p, i) => p.color.join(' ') + ' rg ' + p.x + ' ' + (792 - p.y - 110) +
    ' 220 110 re f\n0 0 0 rg BT /F1 16 Tf ' + (p.x + 10) + ' ' + (792 - p.y - 25) + ' Td (Panel ' + String.fromCharCode(65 + i) + ') Tj ET').join('\n')
    + '\n0 0 0 rg BT /F1 10 Tf 60 311 Td (Control; Treatment) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += (i + 1) + ' 0 obj\n' + object + '\nendobj\n' })
  const start = Buffer.byteLength(pdf)
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
  return Buffer.from(pdf + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + start + '\n%%EOF\n')
}
