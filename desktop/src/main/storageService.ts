import { opendir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { StorageInfo } from '@shared/ipcSchemas'

export async function inspectStorage(rootPath: string): Promise<StorageInfo> {
  const documentsPath = join(rootPath, 'documents-v2')
  const pendingDirectories = [documentsPath]
  let documentCount = 0
  let fileCount = 0
  let totalBytes = 0
  let exists = true

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop()!
    let handle
    try {
      handle = await opendir(directory)
    } catch (error) {
      if (directory === documentsPath && isMissingPath(error)) {
        exists = false
        break
      }
      if (isMissingPath(error) || isAccessDenied(error)) continue
      throw error
    }

    for await (const entry of handle) {
      if (entry.isSymbolicLink()) continue
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (directory === documentsPath) documentCount += 1
        pendingDirectories.push(entryPath)
      } else if (entry.isFile()) {
        fileCount += 1
        try {
          totalBytes += (await stat(entryPath)).size
        } catch (error) {
          if (!isMissingPath(error) && !isAccessDenied(error)) throw error
        }
      }
    }
  }

  return { rootPath, exists, documentCount, fileCount, totalBytes }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isAccessDenied(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')
}
