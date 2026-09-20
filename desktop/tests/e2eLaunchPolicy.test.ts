import { describe, expect, it } from 'vitest'
import { shouldDisableGpuSandbox, shouldUseHostCompatibilityMode } from '@shared/e2eLaunchPolicy'
import { findForbiddenUtilityRuntime, isExpectedUtilityBundleFailure, MAX_CAPTURED_OUTPUT } from '../scripts/utility-bundle-smoke.mjs'

describe('E2E GPU launch policy', () => {
  it('enables host compatibility only for test launches', () => {
    expect(shouldUseHostCompatibilityMode({ NODE_ENV: 'test' })).toBe(true)
    expect(shouldUseHostCompatibilityMode({ NODE_ENV: 'production' })).toBe(false)
    expect(shouldUseHostCompatibilityMode({})).toBe(false)
  })

  it('requires the test environment and an explicit opt-in', () => {
    expect(shouldDisableGpuSandbox({ NODE_ENV: 'test', COPILOTIX_E2E_DISABLE_GPU_SANDBOX: 'true' })).toBe(true)
    expect(shouldDisableGpuSandbox({ NODE_ENV: 'production', COPILOTIX_E2E_DISABLE_GPU_SANDBOX: 'true' })).toBe(false)
    expect(shouldDisableGpuSandbox({ NODE_ENV: 'test', COPILOTIX_E2E_DISABLE_GPU_SANDBOX: '1' })).toBe(false)
  })

  it('rejects browser-only utility bundles while accepting the expected node smoke failure', () => {
    expect(findForbiddenUtilityRuntime('const value = document.createElement("div")')).not.toBeNull()
    expect(findForbiddenUtilityRuntime('const value = process.parentPort')).toBeNull()
    expect(isExpectedUtilityBundleFailure({
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'Error: Core utility parent port is unavailable'
    })).toBe(true)
    expect(isExpectedUtilityBundleFailure({
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'ReferenceError: document is not defined'
    })).toBe(false)
    // The bundled stack is one minified line.  The guard marker can occur
    // after the old 16KiB capture boundary, so retain enough output to see it.
    expect(MAX_CAPTURED_OUTPUT).toBe(128 * 1024)
    expect(isExpectedUtilityBundleFailure({
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: `${'x'.repeat(16 * 1024 + 1)}Error: Core utility parent port is unavailable`
    })).toBe(true)
  })
})
