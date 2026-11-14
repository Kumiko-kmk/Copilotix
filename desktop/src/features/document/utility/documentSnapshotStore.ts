import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, rm, lstat } from 'node:fs/promises'
import { PathPolicy } from '@platform/files/runtime/pathPolicy'
import { documentModels } from './documentModelStore'
import { readMarkdownEditsFile } from '../runtime'
import { getSnapshot, readLegacyTranslations } from '../core'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const policy = new PathPolicy()
async function optional(root: string, name: string): Promise<string> {
  const path = policy.resolveChild(root, name)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error('文件投影來源無效')
    return await readFile(path, 'utf8')
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
}
export async function getDocumentSnapshot(documentId: string, root: string, files?: [string, string, string], translatedPath = 'full.zh-CN.md') {
  const base = await documentModels.ensureBase(documentId, root, files)
  const [edits, manifest, stored] = await Promise.all([readMarkdownEditsFile(root, documentId), optional(root, 'translation.manifest.json'), optional(root, translatedPath)])
  let blocks: ReturnType<typeof readLegacyTranslations> = null
  try { blocks = manifest ? readLegacyTranslations(JSON.parse(manifest), base, hash) : null } catch { /* Historical malformed convenience manifest falls back to durable Markdown. */ }
  const translated = blocks?.length ? blocks.map(block => block.markdown.trimEnd()).join("\n\n") + "\n" : stored
  const snapshot = getSnapshot(base, translated, blocks, edits, hash)
  if ((await documentModels.ensureBase(documentId, root, files)).sourceVersion !== base.sourceVersion || (await readMarkdownEditsFile(root, documentId)).revision !== edits.revision) throw new Error('文件版本已變化，請重新讀取')
  return snapshot
}
/** Immutable, content-addressed projection: Main reads large context through a small descriptor. */
export async function snapshotTextFile(root: string, text: string): Promise<{ path: string; hash: string }> {
  const digest = hash(text), path = policy.resolveChild(root, 'model/snapshot-' + digest + '.md')
  if (await optional(root, 'model/snapshot-' + digest + '.md') === text) return { path, hash: digest }
  const pending = path + '.' + randomUUID() + '.partial'
  try { await writeFile(pending, text, { flag: 'wx' }); await rename(pending, path) }
  finally { await rm(pending, { force: true }).catch(() => undefined) }
  return { path, hash: digest }
}
