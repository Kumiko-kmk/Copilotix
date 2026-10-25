import type { StorageInfo } from '@shared/ipcSchemas'
const cache = new Map<string, { value?: StorageInfo; updated: number; pending?: Promise<StorageInfo> }>()
export function cachedStorageInfo(root: string): StorageInfo | null { return cache.get(root)?.value ?? null }
export function loadStorageInfo(root: string, force = false): Promise<StorageInfo> {
  let entry = cache.get(root)
  if (!entry) { entry = { updated: 0 }; cache.set(root, entry) }
  if (entry.pending) return entry.pending
  if (!force && entry.value && Date.now() - entry.updated < 60_000) return Promise.resolve(entry.value)
  const current = entry
  current.pending = Promise.resolve().then(() => window.copilotix.getStorageInfo()).then(value => {
    if (!value || value.rootPath !== root) throw new Error('文库路径已变更，请重新刷新存储统计')
    current.value = value; current.updated = Date.now()
    return value
  }).finally(() => { current.pending = undefined })
  return current.pending
}
