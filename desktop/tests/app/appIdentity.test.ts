import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FULL_IDENTITY, LITE_IDENTITY } from '../../src/app/contract/appIdentity'
import { CREDENTIAL_SERVICE, credentialServiceForRuntime } from '@platform/credentials/main/credentialVault'

/** electron-builder's installation GUID: UUID v5 of the appId in its own namespace. */
function builderGuid(appId: string): string {
  const namespace = Buffer.from('50e065bc313411e69bab38c9862bdaf3', 'hex')
  const hash = createHash('sha1').update(namespace).update(appId).digest()
  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

describe('edition identity', () => {
  it('keeps the full edition exactly where existing installations have their data', () => {
    const build = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')).build as Record<string, string>
    expect(FULL_IDENTITY).toMatchObject({
      appId: build.appId, productName: build.productName, executableName: build.executableName,
      userDataFolder: 'Copilotix-Translation-v2', credentialService: CREDENTIAL_SERVICE, documentsFolder: 'Copilotix', releaseDirectory: 'release'
    })
  })

  it('shares no installation, data, key or release location between editions', () => {
    const fields = Object.keys(FULL_IDENTITY) as Array<keyof typeof FULL_IDENTITY>
    for (const field of fields) expect(LITE_IDENTITY[field], field).not.toBe(FULL_IDENTITY[field])
  })

  it('declares the GUID electron-builder derives, so the uninstall launcher finds the installation', () => {
    expect(builderGuid(FULL_IDENTITY.appId)).toBe(FULL_IDENTITY.installGuid)
    expect(builderGuid(LITE_IDENTITY.appId)).toBe(LITE_IDENTITY.installGuid)
  })

  it('stores Lite keys under its own service, still isolated per test workspace', () => {
    const service = LITE_IDENTITY.credentialService
    expect(credentialServiceForRuntime({ service, isPackaged: true })).toBe(service)
    const isolated = credentialServiceForRuntime({ service, isPackaged: false, nodeEnv: 'test', e2eUserData: 'C:/workspace' })
    expect(isolated.startsWith(`${service}-e2e-`)).toBe(true)
    expect(credentialServiceForRuntime({ isPackaged: true })).toBe(CREDENTIAL_SERVICE)
  })
})
