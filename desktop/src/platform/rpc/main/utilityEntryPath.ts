import { join } from 'node:path'

export interface UtilityEntryPathOptions {
  isPackaged: boolean
  bundleDirectory: string
  resourcesPath: string
}

/** Resolve utility code to a real file in production instead of the ASAR VFS. */
export function resolveUtilityEntryPath(options: UtilityEntryPathOptions): string {
  return options.isPackaged
    ? join(options.resourcesPath, 'app.asar.unpacked', 'out', 'utility', 'index.js')
    : join(options.bundleDirectory, '..', 'utility', 'index.js')
}
