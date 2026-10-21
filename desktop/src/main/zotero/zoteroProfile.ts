import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ZoteroProfile {
  /** Folder holding zotero.sqlite and storage/. */
  dataDir: string
  /** Base folder for "attachments:" relative linked files; null when unset. */
  baseAttachmentPath: string | null
  port: number
}

const DEFAULT_PORT = 23119

/**
 * Finds the Zotero data folder the same way Zotero does: the profile's prefs.js may point
 * `extensions.zotero.dataDir` elsewhere, otherwise it is ~/Zotero.
 */
export async function locateZoteroProfile(env: { appData?: string; home?: string } = {}): Promise<ZoteroProfile> {
  const home = env.home ?? homedir()
  const appData = env.appData ?? process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
  const prefs = await readProfilePrefs(join(appData, 'Zotero', 'Zotero'))
  const useDataDir = prefs.get('extensions.zotero.useDataDir') === true
  const dataDir = useDataDir && typeof prefs.get('extensions.zotero.dataDir') === 'string'
    ? prefs.get('extensions.zotero.dataDir') as string
    : join(home, 'Zotero')
  const base = prefs.get('extensions.zotero.baseAttachmentPath')
  const port = prefs.get('extensions.zotero.httpServer.port')
  return {
    dataDir,
    baseAttachmentPath: typeof base === 'string' && base ? base : null,
    port: typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT
  }
}

async function readProfilePrefs(profilesRoot: string): Promise<Map<string, unknown>> {
  const profileDir = await defaultProfileDir(profilesRoot)
  if (!profileDir) return new Map()
  try {
    return parsePrefs(await readFile(join(profileDir, 'prefs.js'), 'utf8'))
  } catch {
    return new Map()
  }
}

async function defaultProfileDir(profilesRoot: string): Promise<string | null> {
  try {
    const ini = await readFile(join(profilesRoot, 'profiles.ini'), 'utf8')
    let current: { path?: string; relative?: boolean; isDefault?: boolean } = {}
    const sections: typeof current[] = []
    for (const raw of ini.split(/\r?\n/u)) {
      const line = raw.trim()
      if (line.startsWith('[')) {
        current = {}
        sections.push(current)
      } else if (line.startsWith('Path=')) current.path = line.slice(5)
      else if (line.startsWith('IsRelative=')) current.relative = line !== 'IsRelative=0'
      else if (line === 'Default=1') current.isDefault = true
    }
    const chosen = sections.find((section) => section.isDefault && section.path) ?? sections.find((section) => section.path)
    if (chosen?.path) return chosen.relative === false ? chosen.path : join(profilesRoot, chosen.path)
  } catch {
    // Fall through to the first folder under Profiles/.
  }
  try {
    const entries = await readdir(join(profilesRoot, 'Profiles'), { withFileTypes: true })
    const first = entries.find((entry) => entry.isDirectory())
    return first ? join(profilesRoot, 'Profiles', first.name) : null
  } catch {
    return null
  }
}

/** Reads `user_pref("name", value);` lines; values are JSON-compatible JS literals. */
export function parsePrefs(source: string): Map<string, unknown> {
  const prefs = new Map<string, unknown>()
  const pattern = /^user_pref\(("(?:[^"\\]|\\.)*"),\s*(.+)\);\s*$/gmu
  for (const match of source.matchAll(pattern)) {
    try {
      prefs.set(JSON.parse(match[1]!) as string, JSON.parse(match[2]!))
    } catch {
      // Skip values that are not plain JSON literals.
    }
  }
  return prefs
}
