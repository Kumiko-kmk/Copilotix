import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CREDENTIAL_SERVICE } from '@shared/constants'
import { credentialServiceForRuntime, WindowsCredentialVault } from '../src/main/credentialVault'
import { Entry } from '@napi-rs/keyring'

const stored = vi.hoisted(() => new Map<string, string>())
vi.mock('@napi-rs/keyring', () => ({
  Entry: vi.fn(function (service: string, account: string) {
    const key = `${service}:${account}`
    return {
      getPassword: () => stored.get(key) ?? null,
      setPassword: (value: string) => stored.set(key, value),
      deletePassword: () => stored.delete(key)
    }
  })
}))

describe('native credential isolation for E2E', () => {
  beforeEach(() => {
    stored.clear()
    vi.clearAllMocks()
  })

  it.each([
    { isPackaged: true, nodeEnv: 'test', e2eUserData: 'fixture' },
    { isPackaged: false, nodeEnv: 'production', e2eUserData: 'fixture' },
    { isPackaged: false, e2eUserData: 'fixture' },
    { isPackaged: false, nodeEnv: 'test' }
  ])('keeps production storage unless an unpackaged test workspace is explicit: %j', (options) => {
    expect(credentialServiceForRuntime(options)).toBe(CREDENTIAL_SERVICE)
  })

  it('keeps writes and cleanup separate from the user and other test workspaces', async () => {
    const service = (e2eUserData: string) => credentialServiceForRuntime({ isPackaged: false, nodeEnv: 'test', e2eUserData })
    const user = new WindowsCredentialVault()
    const first = new WindowsCredentialVault(service('workspace-a'))
    const second = new WindowsCredentialVault(service('workspace-b'))
    await user.set('qwen-api-key', 'user-secret')
    expect(await first.get('qwen-api-key')).toBeNull()
    await first.set('qwen-api-key', 'test-secret')
    expect(await second.get('qwen-api-key')).toBeNull()
    expect(await user.get('qwen-api-key')).toBe('user-secret')
    expect(await first.get('qwen-api-key')).toBe('test-secret')
    await first.delete('qwen-api-key')
    expect(await first.has('qwen-api-key')).toBe(false)
    expect(await user.get('qwen-api-key')).toBe('user-secret')
    expect(Entry).toHaveBeenCalledWith(service('workspace-a'), 'qwen-api-key')
  })
})
