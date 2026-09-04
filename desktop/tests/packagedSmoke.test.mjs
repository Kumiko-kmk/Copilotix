import { describe, expect, it } from 'vitest'
import {
  PACKAGED_SMOKE_ARG,
  assertPackagedSmokeVersions,
  formatPackagedSmokeMarker,
  shouldRunPackagedSmoke,
  validatePackagedSmokeOutput
} from '../scripts/package-directory.mjs'

const expectedVersions = Object.freeze({ appVersion: '0.1.0', electronVersion: '44.1.1' })

describe('packaged startup smoke contract', () => {
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
