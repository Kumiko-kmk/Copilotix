import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { zoteroExportRecordSchema, zoteroLinkFileSchema, type ZoteroExportRecord, type ZoteroLink, type ZoteroLinkFile } from '../contract/zotero'

/**
 * `<document>/zotero/link.v1.json` records which Zotero items a paper came from. It lives in the
 * document folder (backed up, restored and migrated with it) so no database migration is needed;
 * older builds ignore the folder. An unreadable file is treated as "no links".
 */
export function zoteroLinkPath(outputDir: string): string {
  return join(outputDir, 'zotero', 'link.v1.json')
}

export async function readZoteroLinks(outputDir: string): Promise<ZoteroLink[]> {
  try {
    const parsed = zoteroLinkFileSchema.safeParse(JSON.parse(await readFile(zoteroLinkPath(outputDir), 'utf8')))
    return parsed.success ? parsed.data.links : []
  } catch {
    return []
  }
}

/** Adds or refreshes one link (same library and item key) and publishes the file atomically. */
export async function addZoteroLink(outputDir: string, link: ZoteroLink): Promise<void> {
  const current = await readZoteroLinks(outputDir)
  const links = [
    ...current.filter((entry) => !(entry.itemKey === link.itemKey && entry.groupID === link.groupID)),
    link
  ].slice(-64)
  const file: ZoteroLinkFile = zoteroLinkFileSchema.parse({ version: 1, links })
  await writeJsonAtomic(zoteroLinkPath(outputDir), file)
}

/** `<document>/zotero/export.v1.json`: each time the paper was sent to Zotero (newest last). */
export async function readZoteroExports(outputDir: string): Promise<ZoteroExportRecord['exports']> {
  try {
    const parsed = zoteroExportRecordSchema.safeParse(JSON.parse(await readFile(join(outputDir, 'zotero', 'export.v1.json'), 'utf8')))
    return parsed.success ? parsed.data.exports : []
  } catch {
    return []
  }
}

export async function addZoteroExport(outputDir: string, entry: ZoteroExportRecord['exports'][number]): Promise<void> {
  const exports = [...await readZoteroExports(outputDir), entry].slice(-64)
  await writeJsonAtomic(join(outputDir, 'zotero', 'export.v1.json'), zoteroExportRecordSchema.parse({ version: 1, exports }))
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const partial = `${target}.partial-${randomUUID()}`
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(partial, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    const handle = await open(partial, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(partial, target)
  } finally {
    await rm(partial, { force: true }).catch(() => undefined)
  }
}
