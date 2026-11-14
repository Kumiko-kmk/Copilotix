import { createHash } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { PathPolicy } from '@platform/files/runtime/pathPolicy'
import type { V2TaskRepositoryCompat } from '@features/library/utility'
import { archiveCoverSourceRequestSchema, figureInsightLocationSchema, figureInsightRecordSchema,
  type ArchiveCoverSource } from '../contract/figureInsight'

type Repository = Pick<V2TaskRepositoryCompat, 'getTask'> & Partial<Pick<V2TaskRepositoryCompat, 'getLatestArtifactReference'>>
type Figure = z.infer<typeof figureInsightLocationSchema>
const policy = new PathPolicy()
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const VERSION = 'archive-cover-source-v1'
const manifestSchema = z.object({ version: z.literal(1), figures: z.array(figureInsightLocationSchema).max(2000) }).strict()
  .refine(value => new Set(value.figures.map(figure => figure.figureId)).size === value.figures.length)

/** Fixed paths and bounded reads only; never load Markdown, mappings, layout or PNG bytes. */
async function readSmall(root: string, name: string, limit: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const path = policy.resolveChild(root, name)
  const declared = await lstat(join(root, name))
  if (!declared.isFile() || declared.isSymbolicLink() || declared.size > limit) throw new Error('invalid cover source')
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > limit) throw new Error('invalid cover source')
    const bytes = Buffer.alloc(Math.min(limit + 1, before.size + 1))
    let length = 0
    while (length < bytes.length) {
      signal?.throwIfAborted()
      const part = await handle.read(bytes, length, bytes.length - length, length)
      if (!part.bytesRead) break
      length += part.bytesRead
    }
    const after = await handle.stat()
    if (length > limit || length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('cover source changed')
    }
    return { bytes: bytes.subarray(0, length), stat: after }
  } finally { await handle.close() }
}

function artifactSignature(repository: Repository, documentId: string): string {
  return JSON.stringify(['source_pdf', 'parsed_markdown', 'layout', 'block_mappings'].map(kind => {
    const reference = repository.getLatestArtifactReference?.(documentId, kind as 'source_pdf' | 'parsed_markdown' | 'layout' | 'block_mappings')
    return reference ? [kind, reference.id, reference.revision, reference.contentHash] : [kind, null]
  }))
}

async function pngSignature(root: string, figure: Figure): Promise<unknown[]> {
  policy.resolveChild(root, figure.imagePath)
  try {
    const info = await lstat(join(root, figure.imagePath))
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 32 * 1024 * 1024) throw new Error('invalid cover image')
    return [figure.figureId, figure.pngSha256, info.size, info.mtimeMs]
  } catch (error) {
    if (absent(error)) return [figure.figureId, figure.pngSha256, 'missing']
    throw error
  }
}

async function savedWeight(root: string, documentId: string, figure: Figure, signal?: AbortSignal): Promise<{ signature: string; displayWeight?: number }> {
  try {
    const { bytes } = await readSmall(root, `insight/figures/${hash(figure.figureId)}.v1.json`, 64 * 1024, signal)
    const signature = hash(bytes)
    let value: unknown
    try { value = JSON.parse(bytes.toString('utf8')) as unknown } catch { return { signature } }
    const parsed = figureInsightRecordSchema.safeParse(value)
    if (!parsed.success) return { signature }
    const record = parsed.data
    if (record.documentId !== documentId || record.figure.figureId !== figure.figureId ||
      record.figure.pngSha256 !== figure.pngSha256 || record.figure.sourceRevision !== figure.sourceRevision ||
      record.figure.imagePath !== figure.imagePath || record.figure.width !== figure.width || record.figure.height !== figure.height ||
      record.figure.pageIndex !== figure.pageIndex || JSON.stringify(record.figure.cropBox) !== JSON.stringify(figure.cropBox)) return { signature }
    return { signature, displayWeight: record.content.displayWeight }
  } catch (error) {
    signal?.throwIfAborted()
    return { signature: absent(error) ? 'missing' : 'invalid' }
  }
}

/** Cover-only projection of durable figure data; independent of generation/descriptor state. */
export async function loadArchiveCoverSource(repository: Repository, documentId: string, signal?: AbortSignal): Promise<ArchiveCoverSource> {
  archiveCoverSourceRequestSchema.parse({ documentId })
  try {
    signal?.throwIfAborted()
    const task = repository.getTask(documentId)
    if (!task) throw new Error('missing document')
    const root = await lstat(task.outputDir)
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('invalid document root')
    const artifacts = artifactSignature(repository, documentId)
    const fingerprintBase = [VERSION, task.sourceHash, artifacts]
    let source: Awaited<ReturnType<typeof readSmall>>
    try { source = await readSmall(task.outputDir, 'figures.json', 2 * 1024 * 1024, signal) }
    catch (error) {
      if (absent(error)) return { fingerprint: hash(JSON.stringify([...fingerprintBase, 'missing-manifest'])), hasManifest: false, figures: [] }
      throw error
    }
    const manifest = manifestSchema.parse(JSON.parse(source.bytes.toString('utf8')) as unknown)
    const figures = new Array<ArchiveCoverSource['figures'][number]>(manifest.figures.length)
    const signatures = new Array<unknown>(manifest.figures.length)
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(4, manifest.figures.length) }, async () => {
      for (;;) {
        signal?.throwIfAborted()
        const index = cursor++
        const figure = manifest.figures[index]
        if (!figure) return
        const [png, weight] = await Promise.all([pngSignature(task.outputDir, figure), savedWeight(task.outputDir, documentId, figure, signal)])
        signatures[index] = [png, weight.signature]
        figures[index] = { figureId: figure.figureId, imagePath: figure.imagePath, width: figure.width, height: figure.height,
          pageIndex: figure.pageIndex, cropBox: figure.cropBox, ...(weight.displayWeight === undefined ? {} : { displayWeight: weight.displayWeight }) }
      }
    }))
    signal?.throwIfAborted()
    const after = await lstat(policy.resolveChild(task.outputDir, 'figures.json'))
    if (after.size !== source.stat.size || after.mtimeMs !== source.stat.mtimeMs || after.ino !== source.stat.ino ||
      repository.getTask(documentId)?.sourceHash !== task.sourceHash || artifactSignature(repository, documentId) !== artifacts) {
      throw new Error('cover source changed')
    }
    return { fingerprint: hash(JSON.stringify([...fingerprintBase, hash(source.bytes), signatures])), hasManifest: true, figures }
  } catch {
    signal?.throwIfAborted()
    throw new Error('无法读取本地封面来源，请检查论文图像清单后重试。')
  }
}
