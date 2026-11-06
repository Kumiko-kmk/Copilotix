const { chromium } = require('@playwright/test')
const { spawn } = require('node:child_process')
const { createServer } = require('node:net')
const { mkdir, writeFile } = require('node:fs/promises')
const { resolve, join } = require('node:path')
const executable = resolve(process.argv[2])
const reportDir = resolve(process.argv[3])
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function main() {
  await mkdir(reportDir, { recursive: true })
  const results = []
  for (let i = 0; i < 3; i++) {
    const port = await freePort()
    const started = Date.now()
    const child = spawn(executable, [`--remote-debugging-port=${port}`], { windowsHide: true, stdio: 'ignore' })
    let exited = false
    child.once('exit', () => { exited = true })
    const error = new Promise((_, reject) => child.once('error', reject))
    const connection = (async () => {
      while (Date.now() - started < 120_000) {
        if (exited) throw new Error('Portable executable exited before its window was ready')
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`)
          if (response.ok) return await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
        } catch { /* Wait for this process's debug listener, not the wrapper's stdout. */ }
        await pause(100)
      }
      throw new Error('Portable executable did not expose its window in time')
    })()
    const browser = await Promise.race([connection, error])
    let page
    try {
      const context = browser.contexts()[0]
      page = context.pages()[0] ?? await context.waitForEvent('page')
      await page.waitForFunction(() => window.readerAcceptance?.metrics.firstPdfMs > 0 && window.readerAcceptance?.metrics.markdownReadyMs > 0, null, { timeout: 120_000 })
      const data = await page.evaluate(started => ({
        processToPdfMs: performance.timeOrigin + window.readerAcceptance.metrics.firstPdfMs - started,
        processToMarkdownMs: performance.timeOrigin + window.readerAcceptance.metrics.markdownReadyMs - started,
        documentMetrics: { ...window.readerAcceptance.metrics }, footprint: window.readerAcceptance.footprint(),
        rendering: window.readerAcceptance.snapshot(), title: document.querySelector('.acceptance-title').textContent
      }), started)
      results.push(data)
      if (i === 0) {
        data.navigation = await require('./verify-navigation.cjs')(page)
        await page.screenshot({ path: join(reportDir, 'portable-translated.png') })
      }
      await writeFile(join(reportDir, 'benchmark.json'), JSON.stringify({ scope: 'single-file portable EXE, including self-extraction; OS file cache not flushed', results }, null, 2))
      console.log(JSON.stringify({ run: i + 1, ...data }))
    } finally {
      if (page) await page.evaluate(() => window.close()).catch(() => {})
      await browser.close()
      const deadline = Date.now() + 15000
      while (!exited && Date.now() < deadline) await pause(100)
      if (!exited) throw new Error('Portable launcher did not finish its own cleanup')
    }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
