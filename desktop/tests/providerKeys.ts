import { createConnection, type KeyProvider, type ProviderKey } from '@platform/models/contract/models'
import { keyConnection } from '@platform/models/main/modelRuntime'
import type { CredentialVault } from '@platform/credentials/main/credentialVault'

/** One resolved key on a provider's connection (the default one unless an id suffix is given). */
export function providerKey(key: string, provider: KeyProvider = 'qwen', suffix = 'default'): ProviderKey {
  return { connection: keyConnection(createConnection(provider, `${provider}:${suffix}`, 0), key), key }
}

/** The 1.3.0 single-key layout: each provider's default vault account, if set. */
export function keysFromVault(vault: Pick<CredentialVault, 'get'>) {
  return async (provider: KeyProvider): Promise<ProviderKey[]> => {
    const key = await vault.get(`${provider}-api-key`)
    return key ? [providerKey(key, provider)] : []
  }
}
