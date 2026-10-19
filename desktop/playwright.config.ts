import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // Native Electron windows share one Windows desktop and foreground focus.
  workers: process.platform === 'win32' ? 1 : undefined,
  timeout: 60_000,
  // Retain actions, DOM and network evidence without continuously reading back
  // the full-resolution WebGL canvas into the trace's screencast.
  use: { trace: { mode: 'retain-on-failure', screenshots: false, snapshots: true, sources: true }, screenshot: 'only-on-failure' },
  reporter: [['list'], ['html', { open: 'never' }]]
})
