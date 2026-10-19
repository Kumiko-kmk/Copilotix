import { defineConfig, type PlaywrightTestConfig } from '@playwright/test'

/**
 * Full CI validation splits Electron E2E across parallel jobs by measured duration (windows-2025,
 * 2026-10-19: ~652 s in total). Playwright's own --shard balances test counts, which would put the
 * single long archive test beside reader's twelve. The last shard takes every unlisted file, so a
 * new spec is never dropped.
 */
const E2E_SHARDS = [
  ['paper-archive', 'paper-chat', 'window-controls', 'library'], // ~214 s
  ['reader', 'archive-math', 'reader-figures', 'smoke'] // ~213 s
]

/** COPILOTIX_E2E_SHARD is `index/total`; a total that disagrees with this list would skip files. */
function shardFiles(value = process.env.COPILOTIX_E2E_SHARD): Pick<PlaywrightTestConfig, 'testMatch' | 'testIgnore'> {
  if (!value) return {}
  const count = E2E_SHARDS.length + 1
  const match = /^(\d+)\/(\d+)$/u.exec(value)
  const shard = Number(match?.[1])
  if (Number(match?.[2]) !== count || shard < 1 || shard > count) {
    throw new Error(`COPILOTIX_E2E_SHARD must be 1/${count} to ${count}/${count}`)
  }
  const files = (names: readonly string[]) => names.map((name) => new RegExp(`[\\\\/]${name}\\.spec\\.ts$`, 'u'))
  return shard <= E2E_SHARDS.length ? { testMatch: files(E2E_SHARDS[shard - 1]!) } : { testIgnore: files(E2E_SHARDS.flat()) }
}

export default defineConfig({
  testDir: './e2e',
  ...shardFiles(),
  // Native Electron windows share one Windows desktop and foreground focus.
  workers: process.platform === 'win32' ? 1 : undefined,
  timeout: 60_000,
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  reporter: [['list'], ['html', { open: 'never' }]]
})
