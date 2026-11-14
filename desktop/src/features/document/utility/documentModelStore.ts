import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { z } from 'zod'
import { PathPolicy } from '@platform/files/runtime/pathPolicy'
import { buildDocumentBase, DOCUMENT_MODEL_VERSION, MARKDOWN_MAPPING_ALGORITHM_VERSION } from '../core'
import { blockMappingSchema } from '../contract/blockSchemas'
import type { DocumentBase, DocumentModelDescriptor } from '../contract/documentModel'
const hash = (s: string): string => createHash('sha256').update(s).digest('hex')
const mappingFile = z.object({ mappings: z.array(blockMappingSchema).max(100_000) }).passthrough()
const policy = new PathPolicy()
export class DocumentModelStore {
  private pending = new Map<string, Promise<DocumentBase>>()
  private cache = new Map<string, DocumentBase>()
  private signatures = new Map<string, string>()
  sourceFiles?: (documentId: string, root: string) => [string, string, string]
  builds = 0
  ensureBase(documentId: string, root: string, files = this.sourceFiles?.(documentId, root) ?? ['full.md', 'block_list.json', 'layout.json']): Promise<DocumentBase> {
    const key = root + '\0' + documentId + JSON.stringify(files)
    const existing = this.pending.get(key)
    if (existing) return existing
    const run = this.ensure(documentId, root, files)
    this.pending.set(key, run)
    void run.finally(() => { if (this.pending.get(key) === run) this.pending.delete(key) }).catch(() => undefined)
    return run
  }
  private async inputs(root: string, files: string[]): Promise<[string, string, string]> {
    return Promise.all(files.map(async name => {
      if (!name) return ''
      try {
        const path = policy.resolveChild(root, name)
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error('文件模型來源無效')
        return await readFile(path, 'utf8')
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
    })) as Promise<[string, string, string]>
  }
  private version(input: string[]): string { return hash(JSON.stringify([DOCUMENT_MODEL_VERSION, MARKDOWN_MAPPING_ALGORITHM_VERSION, ...input])) }
  private async signature(root: string, files: string[]): Promise<string> {
    const values = await Promise.all([...files, 'model/base.v1.json'].filter(Boolean).map(async name => {
      try {
        const info = await lstat(policy.resolveChild(root, name))
        return [name, info.size, info.mtimeMs, info.ctimeMs, info.ino]
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [name, null]
        throw error
      }
    }))
    return JSON.stringify(values)
  }
  private async ensure(documentId: string, root: string, files: string[]): Promise<DocumentBase> {
    const key = root + '\0' + documentId
    const cached = this.cache.get(key)
    if (cached && this.signatures.get(key) === await this.signature(root, files)) return cached
    const input = await this.inputs(root, files)
    const sourceVersion = this.version(input)
    const path = policy.resolveChild(root, 'model/base.v1.json')
    let base: DocumentBase | undefined
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as { base: DocumentBase; digest: string }
      if (raw.digest === hash(JSON.stringify(raw.base)) && raw.base.documentId === documentId && raw.base.sourceVersion === sourceVersion && raw.base.modelVersion === DOCUMENT_MODEL_VERSION && Array.isArray(raw.base.content) && Array.isArray(raw.base.blocks) && typeof raw.base.markdown === 'string' && Array.isArray(raw.base.mappings)) base = raw.base
    } catch { /* Derived cache can always be rebuilt from durable source files. */ }
    if (!base) {
      const parsed: unknown = input[1] ? JSON.parse(input[1]) : { mappings: [] }
      const mappings = Array.isArray(parsed) ? z.array(blockMappingSchema).parse(parsed) : mappingFile.parse(parsed).mappings
      base = buildDocumentBase(documentId, sourceVersion, input[0], mappings, input[2] || '{}')
      this.builds++
      if (this.version(await this.inputs(root, files)) !== sourceVersion) throw new Error('文件來源已變化，請重新讀取')
      await mkdir(policy.resolveChild(root, 'model'), { recursive: true })
      const partial = policy.resolveChild(root, 'model/base.v1.' + randomUUID() + '.partial')
      try {
        const handle = await open(partial, 'wx')
        try { await handle.writeFile(JSON.stringify({ digest: hash(JSON.stringify(base)), base })); await handle.sync() } finally { await handle.close() }
        if (this.version(await this.inputs(root, files)) !== sourceVersion) throw new Error('文件來源已變化，請重新讀取')
        await rename(partial, path)
      } finally { await rm(partial, { force: true }).catch(() => undefined) }
    }
    const after = await this.signature(root, files)
    if (this.version(await this.inputs(root, files)) !== sourceVersion || after !== await this.signature(root, files)) throw new Error('文件來源已變化，請重新讀取')
    this.cache.delete(key); this.cache.set(key, base)
    this.signatures.set(key, after)
    if (this.cache.size > 8) { const oldest = this.cache.keys().next().value!; this.cache.delete(oldest); this.signatures.delete(oldest) }
    return base
  }
  async descriptor(documentId: string, root: string): Promise<DocumentModelDescriptor> {
    const base = await this.ensureBase(documentId, root)
    return { documentId, sourceVersion: base.sourceVersion, path: 'model/base.v1.json', digest: hash(JSON.stringify(base)) }
  }
}
export const documentModels = new DocumentModelStore()
