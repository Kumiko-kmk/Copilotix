import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { PathPolicy } from '@platform/files/runtime/pathPolicy'
import type { V2TaskRepositoryCompat } from '@features/library/utility'
import { archiveTranslatedTitle } from '@features/library/core'
import { archiveInsightListRequestSchema, type ArchiveInsightSnapshot } from '../contract/archiveInsight'
import type { PaperInsightState } from '../contract/paperInsight'

type Repository = Pick<V2TaskRepositoryCompat, 'getTask' | 'getLatestArtifactReference'> &
  Partial<Pick<V2TaskRepositoryCompat, 'getDocumentSummary'>>
type Artifact = ReturnType<Repository['getLatestArtifactReference']>
const HEADER_BYTES = 16 * 1024
const policy = new PathPolicy()
const revision = (artifact: Artifact): string => artifact
  ? JSON.stringify([artifact.id, artifact.revision, artifact.contentHash, artifact.relativePath]) : 'none'

async function safeArtifact(root: string, artifact: Artifact): Promise<string | null> {
  if (!artifact) return null
  const path = policy.resolveChild(root, artifact.relativePath)
  const declared = join(root, artifact.relativePath)
  const info = await lstat(declared)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) return null
  return path
}

/** Read only a bounded translated header, keeping UTF-8 and the final line complete. */
async function translatedHeading(path: string | null): Promise<string> {
  if (!path) return ''
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size <= 0) return ''
    const bytes = Buffer.alloc(Math.min(HEADER_BYTES, before.size))
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    let header = new StringDecoder('utf8').write(bytes.subarray(0, bytesRead))
    if (bytesRead < before.size) header = header.slice(0, header.lastIndexOf('\n') + 1)
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return ''
    const title = archiveTranslatedTitle(header, true)
    return title.length <= 512 ? title : ''
  } finally { await handle.close() }
}

async function catalogRow(repository: Repository, getSaved: (id: string) => Promise<PaperInsightState>, documentId: string,
  signal?: AbortSignal): Promise<ArchiveInsightSnapshot> {
  const row: ArchiveInsightSnapshot = {
    documentId, updatedAt: '1970-01-01T00:00:00.000Z',
    workflowStatus: 'failed', savedStatus: 'failed', ready: false,
    translatedTitle: '', keywords: [], tldr: ''
  }
  try {
    signal?.throwIfAborted()
    const task = repository.getTask(documentId)
    const summary = repository.getDocumentSummary?.(documentId)
    row.updatedAt = summary?.updatedAt ?? task?.updatedAt ?? row.updatedAt
    row.workflowStatus = summary?.workflow.status ?? task?.status ?? 'failed'
    if (!task) return row
    const root = await lstat(task.outputDir)
    if (!root.isDirectory() || root.isSymbolicLink()) return row
    const original = repository.getLatestArtifactReference(documentId, 'parsed_markdown')
    const translated = repository.getLatestArtifactReference(documentId, 'translated_markdown')
    const saved = await getSaved(documentId)
    signal?.throwIfAborted()
    const translatedPath = await safeArtifact(task.outputDir, translated).catch(() => null)
    row.translatedTitle = await translatedHeading(translatedPath).catch(() => '')
    if (saved.status === 'ready') {
      row.savedStatus = saved.stale ? 'stale' : 'ready'
      const source = 'brief' in saved && saved.brief.provenance.language === 'original' ? original : translated ?? original
      const readable = await safeArtifact(task.outputDir, source).catch(() => null)
      if (!readable) row.savedStatus = 'failed'
      row.keywords = ('brief' in saved ? saved.brief.keywords : saved.insight.keywords).slice(0, 8)
      row.tldr = ('brief' in saved ? saved.brief.tldr : saved.insight.summary).slice(0, 120)
      row.ready = row.workflowStatus === 'completed' && row.savedStatus === 'ready' && Boolean(readable)
    } else row.savedStatus = saved.status === 'missing' ? 'missing' : 'failed'
    signal?.throwIfAborted()
    const after = repository.getDocumentSummary?.(documentId)
    if (revision(original) !== revision(repository.getLatestArtifactReference(documentId, 'parsed_markdown')) ||
      revision(translated) !== revision(repository.getLatestArtifactReference(documentId, 'translated_markdown')) ||
      (summary && (!after || after.updatedAt !== summary.updatedAt || after.workflow.status !== summary.workflow.status))) {
      row.savedStatus = 'stale'; row.ready = false
    }
    return row
  } catch {
    signal?.throwIfAborted()
    row.savedStatus = 'failed'; row.ready = false
    return row
  }
}

/** Four small local reads at a time; one broken paper never blocks the catalog page. */
export async function listArchiveInsights(repository: Repository, getSaved: (id: string) => Promise<PaperInsightState>,
  documentIds: readonly string[], signal?: AbortSignal): Promise<ArchiveInsightSnapshot[]> {
  const { documentIds: ids } = archiveInsightListRequestSchema.parse({ documentIds })
  const rows = new Array<ArchiveInsightSnapshot>(ids.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    for (;;) {
      signal?.throwIfAborted()
      const index = cursor++
      const id = ids[index]
      if (!id) return
      rows[index] = await catalogRow(repository, getSaved, id, signal)
    }
  }))
  return rows
}
