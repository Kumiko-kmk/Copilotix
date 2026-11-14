const { _electron: electron } = require('@playwright/test')
const { resolve, join } = require('node:path')
const { writeFile, mkdir } = require('node:fs/promises')
const executable = process.argv[2]
const reportDir = resolve(process.argv[3])
const appDirectory = process.argv[4] ? resolve(process.argv[4]) : null
const runs = Number(process.argv[5] || 3)
async function main() {
  await mkdir(reportDir, { recursive: true })
  const results = []
  for (let i = 0; i < runs; i++) {
    const started = Date.now()
    const app = await electron.launch({ executablePath: executable, args: appDirectory ? [appDirectory] : [], timeout: 120_000 })
    const errors = []
    try {
      const page = await app.firstWindow()
      page.on('pageerror', error => errors.push(error.message))
      await page.waitForFunction(() => window.readerAcceptance?.metrics.firstPdfMs > 0, null, { timeout: 120_000 })
      await page.waitForFunction(() => window.readerAcceptance?.metrics.markdownReadyMs > 0, null, { timeout: 120_000 })
      const result = await page.evaluate(started => {
        const data = window.readerAcceptance
        return { metrics: { ...data.metrics }, processToPdfMs: performance.timeOrigin + data.metrics.firstPdfMs - started,
          processToMarkdownMs: performance.timeOrigin + data.metrics.markdownReadyMs - started,
          rendering: data.snapshot(), footprint: data.footprint(), title: document.querySelector('.acceptance-title')?.textContent }
      }, started)
      if (errors.length) throw new Error(errors.join('\n'))
      results.push(result)
      if (i === 0) {
        await page.screenshot({ path: join(reportDir, 'reader-first-page.png') })
        const candidate = await page.evaluate(() => {
          const elements = [...document.querySelectorAll('.markdown-block[data-block-ids]')]
          return elements.filter(e => e.textContent.length > 100 && !e.querySelector('img,table')).slice(10).find(e => e.getAttribute('data-block-ids'))?.getAttribute('data-block-ids')
        })
        if (!candidate) throw new Error('No mapped paragraph available for linking verification')
        // Match the exact existing mapping string rather than guessing text or page geometry.
        const target = page.locator('.markdown-block').filter({ hasText: /./ }).and(page.locator(`[data-block-ids=${JSON.stringify(candidate)}]`)).first()
        await target.scrollIntoViewIfNeeded()
        await target.click({ position: { x: 20, y: 12 } })
        await page.waitForFunction(ids => {
          const active = document.querySelector('.pdf-block.active')
          return active && ids.includes(active.getAttribute('data-block-id'))
        }, candidate)
        const active = page.locator('.pdf-block.active').first()
        await active.click({ position: { x: 10, y: 5 } })
        await page.waitForFunction(ids => [...document.querySelectorAll('.markdown-block.active')].some(e => e.getAttribute('data-block-ids') === ids), candidate)
        await page.screenshot({ path: join(reportDir, 'reader-linked-paragraph.png') })
        result.linkingVerified = true
        const pageNumber = await page.getByLabel('跳轉到頁', { exact: true }).innerText()
        const totalPages = Number(pageNumber.split('/')[1].trim())
        await page.getByLabel('跳轉到頁', { exact: true }).click()
        await page.getByLabel('PDF 頁碼', { exact: true }).fill(String(totalPages))
        console.log('Checking PDF final page', totalPages)
        const jumpStarted = Date.now()
        await page.getByLabel('PDF 頁碼', { exact: true }).press('Enter')
        await page.waitForFunction(last => {
          const canvas = document.querySelector(`[data-pdf-page="${last}"] canvas`)
          return canvas && canvas.width > 0
        }, totalPages - 1)
        result.lastPageMountedMs = Date.now() - jumpStarted
        result.totalPages = totalPages
        console.log('Checking bilingual navigation')
        result.navigation = await require('./verify-navigation.cjs')(page)
        await page.screenshot({ path: join(reportDir, 'reader-translated.png') })
      }
      await writeFile(join(reportDir, 'benchmark.json'), JSON.stringify({ scope: 'independent process launches; OS disk cache not flushed', executable, results }, null, 2))
      console.log(JSON.stringify({ run: i + 1, ...result }))
    } finally { await app.close() }
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
