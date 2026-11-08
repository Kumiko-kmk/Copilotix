const assert = require('node:assert/strict')

/** Runs against both the unpacked app and the actual portable executable. */
module.exports = async function verifyNavigation(page) {
  const report = {}
  for (const [view, label] of [['original', '原文'], ['translated', '译文']]) {
    console.log('Checking view', view)
    const started = Date.now()
    await page.getByRole('tab', { name: label, exact: true }).click()
    await page.waitForFunction(view => window.readerAcceptance.metrics[view === 'original' ? 'markdownReadyMs' : 'translatedReadyMs'] > 0, view)
    const readyMs = Date.now() - started
    console.log('View ready', view)
    await page.waitForFunction(() => document.querySelectorAll('.markdown-minimap-heading').length > 2)
    const jump = await page.evaluate(async () => {
      const scroller = document.querySelector('.markdown-scroll')
      scroller.scrollTop = 0
      // Clicking the title uses precisely the handler that previously requested smooth scrolling.
      const headings = [...document.querySelectorAll('.markdown-minimap-heading')]
      headings[Math.floor(headings.length * 0.65)].click()
      const immediate = scroller.scrollTop
      const samples = [immediate]
      for (let frame = 0; frame < 8; frame++) {
        await new Promise(requestAnimationFrame)
        samples.push(scroller.scrollTop)
      }
      return { immediate, samples, behavior: getComputedStyle(scroller).scrollBehavior,
        chineseCharacters: (scroller.textContent.match(/[\u3400-\u9fff]/g) || []).length }
    })
    console.log('Instant jump', view, JSON.stringify(jump))
    assert.ok(jump.immediate > 100, `${view}: title click must position synchronously`)
    assert.equal(jump.behavior, 'auto')
    assert.ok(jump.samples.every(value => Math.abs(value - jump.immediate) < 2), `${view}: unexpected scrolling after positioning`)
    if (view === 'translated') assert.ok(jump.chineseCharacters > 500, 'Actual translated prose must be loaded')
    const candidate = await page.evaluate(() => [...document.querySelectorAll('.markdown-block[data-block-ids]')]
      .filter(e => e.textContent.length > 100 && !e.querySelector('img,table')).slice(10).find(e => e.dataset.blockIds)?.dataset.blockIds)
    assert.ok(candidate, `${view}: no linked paragraph`)
    const target = page.locator(`.markdown-block[data-block-ids=${JSON.stringify(candidate)}]`).first()
    await target.scrollIntoViewIfNeeded()
    await target.click({ position: { x: 20, y: 12 } })
    await page.waitForFunction(ids => [...document.querySelectorAll('.pdf-block.active')].some(e => ids.split(' ').includes(e.dataset.blockId)), candidate)
    const pdfId = candidate.split(' ')[0]
    const pdfBlock = page.locator(`.pdf-block[data-block-id=${JSON.stringify(pdfId)}]`).first()
    await pdfBlock.scrollIntoViewIfNeeded()
    await pdfBlock.click()
    await page.waitForFunction(ids => [...document.querySelectorAll('.markdown-block.active')].some(e => e.dataset.blockIds === ids), candidate).catch(async error => {
      console.log(await page.evaluate(() => ({ activePdf: [...document.querySelectorAll('.pdf-block.active')].map(e => e.dataset.blockId), activeMarkdown: [...document.querySelectorAll('.markdown-block.active')].map(e => e.dataset.blockIds) })))
      throw error
    })
    report[view] = { readyMs, ...jump, bidirectionalLinking: true }
  }
  return report
}
