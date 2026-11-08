import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Attach to the renderer of the actual installed, fused executable. The installer
// test alone opts into a loopback CDP port; no Node inspector or product changes.
const [profile, evidence] = process.argv.slice(2)
if (!profile || !evidence) throw new Error('Expected test profile and evidence directory')
const deadline = Date.now() + 30_000
let port
while (Date.now() < deadline) {
  try {
    const candidate = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/u)[0])
    if (Number.isInteger(candidate) && candidate > 0 && candidate < 65536) { port = candidate; break }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await new Promise(resolve => setTimeout(resolve, 200))
}
if (!port) throw new Error('Installed renderer did not expose its test CDP port')
let target
const targetDeadline = Date.now() + 30_000
while (Date.now() < targetDeadline) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) })).json()
  target = targets.find(item => item.type === 'page' && item.url.startsWith('file:'))
  if (target?.webSocketDebuggerUrl) break
  await new Promise(resolve => setTimeout(resolve, 200))
}
if (!target?.webSocketDebuggerUrl) throw new Error('Installed renderer target is missing')
// Electron does not implement all of Playwright's browser-level initialization.
// Use only the page protocol, retaining the same DOM and rendering assertions.
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { socket.close(); reject(new Error('Renderer socket timed out')) }, 5_000)
  socket.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
  socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Renderer socket failed')) }, { once: true })
})
let nextId = 0
const pending = new Map()
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  clearTimeout(request.timeout)
  if (message.error) request.reject(new Error(message.error.message))
  else request.resolve(message.result)
})
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 5_000)
    pending.set(id, { resolve, reject, timeout })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}
async function waitFor(expression, message) {
  const until = Date.now() + 30_000
  while (Date.now() < until) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(message)
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(evidence, name), Buffer.from(data, 'base64'))
}
const visible = selector => `document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`
try {
  await waitFor(`Array.from(document.querySelectorAll('h1')).some(element => element.checkVisibility() && element.textContent === '今天想读些什么？')`, 'Installed home did not render')
  await waitFor(visible('nav[aria-label="论文导航"]'), 'Installed sidebar did not render')
  await waitFor(visible('.window-controls'), 'Installed window controls did not render')
  await screenshot('02-installed-home.png')
  await evaluate(`document.querySelector('.paper-sidebar-settings').click()`)
  await waitFor(visible('nav[aria-label="设置分类"]'), 'Installed settings did not open')
  for (const name of ['服务', '存储', '外观']) {
    await evaluate(`Array.from(document.querySelectorAll('.settings-nav button')).find(button => button.textContent === ${JSON.stringify(name)}).click()`)
    await waitFor(`document.querySelector('.settings-window-header h2')?.textContent === ${JSON.stringify(name)} && ${visible('.settings-content-body')}`, `Installed settings page did not render: ${name}`)
  }
  await screenshot('02-installed-settings.png')
  await evaluate(`document.querySelector('button[aria-label="关闭设置"]').click()`)
  await waitFor(`!document.querySelector('nav[aria-label="设置分类"]')`, 'Installed settings did not close')
  await writeFile(join(evidence, 'installed-ui.json'), JSON.stringify({
    completed: true, home: true, sidebar: true, settings: ['服务', '存储', '外观']
  }, null, 2))
  console.log('Installed Lite renderer: home, sidebar and all settings pages passed')
} catch (error) {
  await screenshot('02-installed-failure.png').catch(() => undefined)
  const body = await evaluate('document.body.innerText').catch(() => 'Renderer did not respond')
  await writeFile(join(evidence, 'installed-ui-failure.json'), JSON.stringify({ error: String(error), body }, null, 2))
  throw error
} finally {
  socket.close()
}
