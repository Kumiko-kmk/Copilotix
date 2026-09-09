import { describe, expect, it } from 'vitest'
import { shouldDisableGpuSandbox } from '@shared/e2eLaunchPolicy'
import { findForbiddenUtilityRuntime, isExpectedUtilityBundleFailure } from '../scripts/utility-bundle-smoke.mjs'

describe('E2E GPU launch policy', () => {
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
  })
})
