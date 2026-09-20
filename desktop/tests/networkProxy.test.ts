import { describe, expect, it, vi } from 'vitest'
import { refreshNetworkProxy } from '@main/networkProxy'

describe('network proxy refresh', () => {
  it('reloads the system proxy snapshot and drops pooled connections in order', async () => {
    const calls: string[] = []
    const networkSession = {
      forceReloadProxyConfig: vi.fn(async () => { calls.push('reload') }),
      closeAllConnections: vi.fn(async () => { calls.push('close') })
    }

    await refreshNetworkProxy(networkSession)

    expect(calls).toEqual(['reload', 'close'])
  })

  it('does not close connections when reloading the proxy configuration fails', async () => {
    const networkSession = {
      forceReloadProxyConfig: vi.fn(async () => { throw new Error('reload failed') }),
      closeAllConnections: vi.fn(async () => undefined)
    }

    await expect(refreshNetworkProxy(networkSession)).rejects.toThrow('reload failed')
    expect(networkSession.closeAllConnections).not.toHaveBeenCalled()
  })
})
