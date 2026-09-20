import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { resolveUtilityEntryPath } from '@main/utilityEntryPath'

describe('utility entry path', () => {
  it('uses the adjacent build bundle during development', () => {
    expect(resolveUtilityEntryPath({
      isPackaged: false,
      bundleDirectory: join('C:', 'repo', 'desktop', 'out', 'main'),
      resourcesPath: join('C:', 'release', 'resources')
    })).toBe(join('C:', 'repo', 'desktop', 'out', 'utility', 'index.js'))
  })

  it('uses the unpacked filesystem entry in a packaged app', () => {
    expect(resolveUtilityEntryPath({
      isPackaged: true,
      bundleDirectory: join('C:', 'release', 'resources', 'app.asar', 'out', 'main'),
      resourcesPath: join('C:', 'release', 'resources')
    })).toBe(join('C:', 'release', 'resources', 'app.asar.unpacked', 'out', 'utility', 'index.js'))
  })
})
