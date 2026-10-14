import { describe, expect, it, vi } from 'vitest'
import { cachedStorageInfo, loadStorageInfo } from '../src/renderer/storageInfoClient'
import type { StorageInfo } from '@shared/ipcSchemas'
describe('storage precomputation', () => {
  it('shares an in-flight scan, caches the result and isolates library roots', async () => {
    const value = { rootPath: 'C:/test-cache', totalBytes: 123 } as StorageInfo
    const scan = vi.fn().mockResolvedValue(value)
    vi.stubGlobal('window', { copilotix: { getStorageInfo: scan } })
    try {
      await Promise.all([loadStorageInfo(value.rootPath), loadStorageInfo(value.rootPath)])
      expect(scan).toHaveBeenCalledTimes(1)
      expect(cachedStorageInfo(value.rootPath)).toEqual(value)
      expect(cachedStorageInfo('C:/other-library')).toBeNull()
      await loadStorageInfo(value.rootPath)
      expect(scan).toHaveBeenCalledTimes(1)
      await loadStorageInfo(value.rootPath, true)
      expect(scan).toHaveBeenCalledTimes(2)
    } finally { vi.unstubAllGlobals() }
  })
})
