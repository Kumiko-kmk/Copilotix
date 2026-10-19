import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // Native Electron windows share one Windows desktop and foreground focus.
  workers: process.platform === 'win32' ? 1 : undefined,
  timeout: 60_000,
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  reporter: [['list'], ['html', { open: 'never' }]]
})
