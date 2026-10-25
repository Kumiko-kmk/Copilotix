import { opendir, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import type { StorageCategory, StorageInfo } from '@shared/ipcSchemas'

const IMAGE_EXTENSIONS = new Set(['.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp'])
const CATEGORY_ORDER: StorageCategory['kind'][] = ['source', 'image', 'translation', 'other']

export async function inspectStorage(rootPath: string, now = new Date()): Promise<StorageInfo> {
  const documentsPath = join(rootPath, 'documents-v2')
  const pendingDirectories = [documentsPath]
  const categoryTotals = new Map(CATEGORY_ORDER.map((kind) => [kind, { kind, fileCount: 0, bytes: 0 } satisfies StorageCategory]))
  const growthDays = recentDayStarts(now, 14)
  const dailyGrowth = new Array<number>(growthDays.length).fill(0)
  let growthBaseline = 0
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
        try {
          const metadata = await stat(entryPath)
          const bytes = metadata.size
          const category = categoryTotals.get(classifyStorageFile(relative(documentsPath, entryPath)))!
          fileCount += 1
          totalBytes += bytes
          category.fileCount += 1
          category.bytes += bytes
          const growthIndex = dayIndex(metadata.mtime, growthDays)
          if (growthIndex < 0) growthBaseline += bytes
          else dailyGrowth[Math.min(growthIndex, growthDays.length - 1)]! += bytes
        } catch (error) {
          if (!isMissingPath(error) && !isAccessDenied(error)) throw error
        }
      }
    }
  }

  let cumulativeBytes = growthBaseline
  const growth = growthDays.map((date, index) => {
    cumulativeBytes += dailyGrowth[index]!
    return { date: dateKey(date), totalBytes: cumulativeBytes }
  })
  return { rootPath, exists, documentCount, fileCount, totalBytes, categories: CATEGORY_ORDER.map((kind) => categoryTotals.get(kind)!), growth }
}

function classifyStorageFile(relativePath: string): StorageCategory['kind'] {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase()
  const name = normalized.split('/').at(-1) ?? normalized
  if (IMAGE_EXTENSIONS.has(extname(name))) return 'image'
  if (normalized.includes('/.translation/') || normalized.startsWith('.translation/') || name.includes('.zh-cn.')) return 'translation'
  if (extname(name) === '.pdf') return 'source'
  return 'other'
}

function recentDayStarts(now: Date, count: number): Date[] {
  const first = new Date(now)
  first.setHours(0, 0, 0, 0)
  first.setDate(first.getDate() - count + 1)
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(first)
    day.setDate(first.getDate() + index)
    return day
  })
}

function dayIndex(date: Date, days: Date[]): number {
  const key = dateKey(date)
  const firstKey = dateKey(days[0]!)
  if (key < firstKey) return -1
  const index = days.findIndex((day) => dateKey(day) === key)
  return index < 0 ? days.length : index
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isAccessDenied(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')
}
