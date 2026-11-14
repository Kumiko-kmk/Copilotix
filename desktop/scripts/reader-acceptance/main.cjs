const { app, BrowserWindow, protocol, session } = require('electron')
const { join, resolve, relative, extname, isAbsolute } = require('node:path')
const { stat, realpath } = require('node:fs/promises')
const { createReadStream } = require('node:fs')
const { Readable } = require('node:stream')
protocol.registerSchemesAsPrivileged([{ scheme: 'reader-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
app.setName('Copilotix Reader Acceptance')
app.setPath('userData', join(app.getPath('appData'), 'Copilotix-Reader-Acceptance-20261031'))
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.md': 'text/plain' }
app.whenReady().then(async () => {
  const root = await realpath(app.getAppPath())
  protocol.handle('reader-asset', async request => {
    try {
      const url = new URL(request.url)
      if (url.host !== 'app' || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 403 })
      const name = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'renderer/index.html'
      const file = await realpath(resolve(root, name))
      const rel = relative(root, file)
      if (rel.startsWith('..') || isAbsolute(rel) || !/^(renderer|paper)[\\/]/.test(rel)) return new Response(null, { status: 403 })
      const info = await stat(file)
      if (!info.isFile()) return new Response(null, { status: 404 })
      const range = request.headers.get('range')
      let start = 0, end = info.size - 1, status = 200
      const headers = { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range)
        if (!match) return new Response(null, { status: 416 })
        start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end
        if (start > end || start >= info.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
        headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`; status = 206
      }
      headers['Content-Length'] = String(Math.max(0, end - start + 1))
      return new Response(request.method === 'HEAD' || info.size === 0 ? null : Readable.toWeb(createReadStream(file, { start, end })), { status, headers })
    } catch { return new Response(null, { status: 404 }) }
  })
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(reader-asset:|blob:|data:|devtools:)/.test(details.url) }))
  const window = new BrowserWindow({ width: 1440, height: 960, minWidth: 860, minHeight: 600, title: 'Copilotix · 阅读器验收',
    autoHideMenuBar: true, backgroundColor: '#f7f3e9', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('reader-asset://app/')) event.preventDefault() })
  await window.loadURL('reader-asset://app/renderer/index.html')
})
app.on('window-all-closed', () => app.quit())
