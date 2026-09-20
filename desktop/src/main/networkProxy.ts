export interface RefreshableNetworkSession {
  forceReloadProxyConfig(): Promise<void>
  closeAllConnections(): Promise<void>
}

let refreshTail: Promise<void> = Promise.resolve()

/** Refresh Chromium's system proxy snapshot before an explicit connection test. */
export function refreshNetworkProxy(networkSession: RefreshableNetworkSession): Promise<void> {
  const refresh = refreshTail.then(async () => {
    await networkSession.forceReloadProxyConfig()
    await networkSession.closeAllConnections()
  })
  refreshTail = refresh.catch(() => undefined)
  return refresh
}
