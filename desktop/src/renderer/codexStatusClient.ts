import { useSyncExternalStore } from 'react'
import type { CodexSettings, CodexStatus } from '@shared/codex'
const statuses = new Map<string, CodexStatus>()
const listeners = new Set<() => void>()
const pending = new Map<string, Promise<CodexStatus>>()
const hydrated = new Set<string>()
const key = (settings: CodexSettings): string => JSON.stringify([settings.executable, settings.effort])
function publish(settings: CodexSettings, status: CodexStatus): void {
  statuses.set(key(settings), status)
  if (status.executable) statuses.set(key({ ...settings, executable: status.executable }), status)
  for (const listener of listeners) listener()
}
export function useCodexStatus(settings: CodexSettings): CodexStatus | null {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback) } }, () => statuses.get(key(settings)) ?? null)
}
export async function refreshCodexStatus(settings: CodexSettings, testModel?: string): Promise<CodexStatus> {
  const id = key(settings)
  if (!testModel && pending.has(id)) return pending.get(id)!
  const task = (async () => {
    if (!hydrated.has(id)) {
      hydrated.add(id)
      const saved = await window.copilotix.codex.cached(settings).catch(() => null)
      if (saved && !statuses.has(id)) publish(settings, saved)
    }
    const status = await window.copilotix.codex.inspect({ settings, ...(testModel ? { testModel } : {}) })
    publish(settings, status)
    return status
  })()
  if (!testModel) pending.set(id, task)
  try { return await task } finally { if (pending.get(id) === task) pending.delete(id) }
}
