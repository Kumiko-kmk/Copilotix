import React from 'react'
import { togglePin, type SidebarPins } from '../../core/sidebarSections'

const KEY = 'copilotix.lite.sidebar-sections.v1'

interface Prefs {
  pins: SidebarPins
  /** Section keys the user folded. */
  collapsed: readonly string[]
}

const EMPTY: Prefs = { pins: { global: [], group: [] }, collapsed: [] }

function read(): Prefs {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Partial<Prefs> | null
    const ids = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 500) : []
    return raw ? { pins: { global: ids(raw.pins?.global), group: ids(raw.pins?.group) }, collapsed: ids(raw.collapsed) } : EMPTY
  } catch {
    return EMPTY
  }
}

/**
 * Pins and folded sections, kept in this browser profile. Windows of the app share it, and a change
 * in one reaches the others through the storage event.
 */
export function useSidebarPrefs(): {
  pins: SidebarPins
  collapsed: ReadonlySet<string>
  togglePin(documentId: string, scope: 'global' | 'group'): void
  toggleSection(key: string): void
  replacePins(pins: SidebarPins): void
} {
  const [prefs, setPrefs] = React.useState(read)
  const update = React.useCallback((change: (current: Prefs) => Prefs) => {
    setPrefs((current) => {
      const next = change(current)
      if (next === current) return current
      try { window.localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* Kept for this window only. */ }
      return next
    })
  }, [])
  React.useEffect(() => {
    const onStorage = (event: StorageEvent): void => { if (event.key === KEY) setPrefs(read()) }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  const collapsed = React.useMemo(() => new Set(prefs.collapsed), [prefs.collapsed])
  return {
    pins: prefs.pins,
    collapsed,
    togglePin: React.useCallback((documentId, scope) => update((current) => ({ ...current, pins: togglePin(current.pins, documentId, scope) })), [update]),
    toggleSection: React.useCallback((key) => update((current) => ({
      ...current,
      collapsed: current.collapsed.includes(key) ? current.collapsed.filter((item) => item !== key) : [...current.collapsed, key]
    })), [update]),
    replacePins: React.useCallback((pins) => update((current) => current.pins === pins ? current : { ...current, pins }), [update])
  }
}
