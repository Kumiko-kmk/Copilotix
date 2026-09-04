import { describe, expect, it } from 'vitest'
import {
  PACKAGED_SMOKE_ARG,
  assertDependencyRoots,
  assertPackagedSmokeVersions,
  assertPnpmInvocation,
  formatPackagedSmokeMarker,
  shouldRunPackagedSmoke,
  validatePackagedSmokeOutput
} from '../scripts/package-directory.mjs'

const expectedVersions = Object.freeze({ appVersion: '0.1.0', electronVersion: '44.1.1' })

describe('packaged startup smoke contract', () => {
  it('requires the declared pnpm version and worktree-local dependencies', () => {
    expect(() => assertPnpmInvocation({ npm_config_user_agent: 'pnpm/11.19.0 npm/? node/v24.11.1 win32 x64' })).not.toThrow()
    expect(() => assertPnpmInvocation({})).toThrow(/direct Node\/npm invocation/)
    expect(() => assertPnpmInvocation({ npm_config_user_agent: 'pnpm/10.0.0 npm/?' })).toThrow(/pnpm@10.0.0/)
    expect(() => assertDependencyRoots('C:/workspace', ['C:/workspace/node_modules', 'C:/workspace/desktop/node_modules'])).not.toThrow()
    expect(() => assertDependencyRoots('C:/workspace', ['D:/shared/node_modules'])).toThrow(/outside the current worktree/)
  })

  it('gates the dedicated mode on the packaged app flag', () => {
    expect(shouldRunPackagedSmoke([PACKAGED_SMOKE_ARG], true)).toBe(true)
    expect(shouldRunPackagedSmoke([PACKAGED_SMOKE_ARG], false)).toBe(false)
    expect(shouldRunPackagedSmoke(['--version'], true)).toBe(false)
  })

  it('uses the package-declared app version and requires exact Electron 44.1.1', () => {
    expect(assertPackagedSmokeVersions({ version: '0.1.0', devDependencies: { electron: '44.1.1' } })).toEqual(expectedVersions)
    expect(assertPackagedSmokeVersions({ version: '0.1.1', devDependencies: { electron: '44.1.1' } })).toEqual({ appVersion: '0.1.1', electronVersion: '44.1.1' })
    expect(() => assertPackagedSmokeVersions({ version: '0.1.0\nunexpected', devDependencies: { electron: '44.1.1' } })).toThrow(/Invalid app version/)
    expect(() => assertPackagedSmokeVersions({ version: '0.1.0', devDependencies: { electron: '^44.1.1' } })).toThrow(/44\.1\.1/)
  })

  it('accepts exactly one marker and rejects all extra or error output', () => {
    const marker = formatPackagedSmokeMarker(expectedVersions)
    expect(validatePackagedSmokeOutput({ stdout: marker, stderr: '' }, expectedVersions)).toBe(true)
    expect(validatePackagedSmokeOutput({ stdout: `\r\n${marker}`, stderr: '' }, expectedVersions)).toBe(true)
    expect(validatePackagedSmokeOutput({ stdout: `\r\n\r\n${marker}`, stderr: '' }, expectedVersions)).toBe(false)
    expect(validatePackagedSmokeOutput({ stdout: ` \r\n${marker}`, stderr: '' }, expectedVersions)).toBe(false)
    expect(validatePackagedSmokeOutput({ stdout: `unexpected\r\n${marker}`, stderr: '' }, expectedVersions)).toBe(false)
    expect(validatePackagedSmokeOutput({ stdout: `${marker}unexpected`, stderr: '' }, expectedVersions)).toBe(false)
    expect(validatePackagedSmokeOutput({ stdout: `${marker}${marker}`, stderr: '' }, expectedVersions)).toBe(false)
    expect(validatePackagedSmokeOutput({ stdout: marker, stderr: 'Error: unexpected diagnostic' }, expectedVersions)).toBe(false)
  })
})
