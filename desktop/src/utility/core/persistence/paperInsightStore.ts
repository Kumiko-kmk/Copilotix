import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { paperInsightRecordSchema, paperInsightSchema, PAPER_INSIGHT_MAX_BYTES, type PaperInsight, type PaperInsightState, type PaperInsightContext } from '@shared/paperInsight'
import type { V2TaskRepositoryCompat } from './v2TaskRepositoryCompat'
import { PathPolicy } from './pathPolicy'
import { selectInsightExcerpts } from '../paperInsightContext'
import { buildBriefContext, BRIEF_BUDGETS } from '@shared/paperBrief/context'
import { PAPER_BRIEF_PROMPT_VERSION } from '@shared/paperBrief/prompt'
import { paperBriefRecordSchema, paperBriefSaveSchema, briefContextResultSchema, PAPER_BRIEF_MAX_BYTES, type BriefContextResult, type BriefAnchor } from '@shared/paperBrief/contracts'
import type { PaperBrief } from '@shared/paperBrief/schema'

type Repository = Pick<V2TaskRepositoryCompat, 'getTask' | 'getLatestArtifactReference'>
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

/** Utility data lane serializes read/write/delete; library maintenance waits for this lane. */
export class PaperInsightStore {
  private readonly policy = new PathPolicy()
  constructor(private readonly repository: Repository) {}

  private async snapshot(documentId: string) {
    const task = this.repository.getTask(documentId)
    if (!task) throw new Error('论文不存在')
    const stat = await lstat(task.outputDir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('文献目录无效')
    const original = this.repository.getLatestArtifactReference(documentId, 'parsed_markdown')
    const translated = this.repository.getLatestArtifactReference(documentId, 'translated_markdown')
    const revision = (ref: typeof original) => ref ? `${ref.id}:${ref.revision}:${ref.contentHash}` : 'none'
    return { root: task.outputDir, original, translated, sourceRevision: `p:${revision(original)}|t:${revision(translated)}` }
  }

  private async read(path: string, maxBytes: number): Promise<string> {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('解读来源或文件无效、超过大小限制')
    const handle = await open(path, 'r')
    try {
      if ((await handle.stat()).size > maxBytes) throw new Error('解读文件超过大小限制')
      return await handle.readFile('utf8')
    } finally { await handle.close() }
  }

  private async insightRoot(root: string, create = false): Promise<string> {
    const path = join(root, 'insight')
    try {
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('解读目录无效')
    } catch (error) {
      if (!missing(error)) throw error
      if (create) await mkdir(this.policy.resolveChild(root, 'insight'))
    }
    return this.policy.resolveChild(root, 'insight')
  }

  async get(documentId: string): Promise<PaperInsightState> {
    const snapshot = await this.snapshot(documentId)
    try {
      const root = await this.insightRoot(snapshot.root)
      try {
        const record = paperBriefRecordSchema.parse(JSON.parse(await this.read(join(root, 'brief.v2.json'), PAPER_BRIEF_MAX_BYTES)))
        this.policy.resolveChild(root, 'brief.v2.json')
        if (record.documentId !== documentId) throw new Error('档案卡不属于当前论文')
        return { status: 'ready', brief: record.brief, anchors: record.anchors,
          stale: record.brief.provenance.sourceRevision !== snapshot.sourceRevision,
          promptOutdated: record.brief.provenance.promptVersion !== PAPER_BRIEF_PROMPT_VERSION }
      } catch (error) { if (!missing(error)) throw error }
      const path = join(root, 'insight.v1.json')
      const record = paperInsightRecordSchema.parse(JSON.parse(await this.read(path, PAPER_INSIGHT_MAX_BYTES)))
      this.policy.resolveChild(root, 'insight.v1.json')
      if (record.documentId !== documentId) throw new Error('解读不属于当前论文')
      return { status: 'ready', insight: record.insight, stale: record.insight.sourceRevision !== snapshot.sourceRevision }
    } catch (error) { if (missing(error)) return { status: 'missing' }; throw error }
  }

  async context(documentId: string, budgetBytes: number, signal: AbortSignal): Promise<PaperInsightContext> {
    signal.throwIfAborted()
    const snapshot = await this.snapshot(documentId)
    const artifact = snapshot.translated ?? snapshot.original
    if (!artifact) throw new Error('论文尚未完成解析')
    this.policy.resolveChild(snapshot.root, artifact.relativePath)
    // Preserve the lstat check on the lexical path (resolveChild resolves links).
    const markdown = await this.read(join(snapshot.root, artifact.relativePath), 32 * 1024 * 1024)
    signal.throwIfAborted()
    const after = await this.snapshot(documentId)
    if (after.sourceRevision !== snapshot.sourceRevision) throw new Error('论文内容正在更新，请重试')
    return { documentId, sourceRevision: snapshot.sourceRevision, language: snapshot.translated ? 'translated' : 'original', ...selectInsightExcerpts(markdown, budgetBytes) }
  }

  async briefContext(documentId: string, signal: AbortSignal): Promise<BriefContextResult> {
    signal.throwIfAborted()
    const snapshot = await this.snapshot(documentId)
    const readArtifact = async (artifact: typeof snapshot.original): Promise<string> => {
      if (!artifact) return ''
      this.policy.resolveChild(snapshot.root, artifact.relativePath)
      return this.read(join(snapshot.root, artifact.relativePath), 32 * 1024 * 1024)
    }
    const original = await readArtifact(snapshot.original)
    signal.throwIfAborted()
    const translated = original.trim() ? '' : await readArtifact(snapshot.translated)
    signal.throwIfAborted()
    const context = buildBriefContext(original, translated, BRIEF_BUDGETS.detailed)
    const after = await this.snapshot(documentId)
    if (after.sourceRevision !== snapshot.sourceRevision) throw new Error('论文内容正在更新，请重试')
    return briefContextResultSchema.parse({ documentId, sourceRevision: snapshot.sourceRevision, context })
  }

  async saveBrief(documentId: string, brief: PaperBrief, anchors: BriefAnchor[]): Promise<{ saved: true }> {
    const value = paperBriefSaveSchema.parse({ documentId, brief, anchors })
    const body = JSON.stringify(paperBriefRecordSchema.parse({ version: 2, ...value }))
    return this.commit(documentId, 'brief.v2.json', body, PAPER_BRIEF_MAX_BYTES)
  }

  async save(documentId: string, raw: PaperInsight): Promise<{ saved: true }> {
    const insight = paperInsightSchema.parse(raw)
    const body = JSON.stringify(paperInsightRecordSchema.parse({ version: 1, documentId, insight }))
    return this.commit(documentId, 'insight.v1.json', body, PAPER_INSIGHT_MAX_BYTES)
  }

  private async commit(documentId: string, name: string, body: string, maxBytes: number): Promise<{ saved: true }> {
    if (Buffer.byteLength(body) > maxBytes) throw new Error('解读文件超过大小限制')
    const snapshot = await this.snapshot(documentId)
    const root = await this.insightRoot(snapshot.root, true)
    const target = join(root, name)
    try { if ((await lstat(target)).isSymbolicLink()) throw new Error('解读文件不能是符号链接') } catch (error) { if (!missing(error)) throw error }
    this.policy.resolveChild(root, name)
    const temporary = this.policy.resolveChild(root, `.pending-${randomUUID()}`)
    try {
      const handle = await open(temporary, 'wx')
      try { await handle.writeFile(body, 'utf8'); await handle.sync() } finally { await handle.close() }
      // A cancelled Main request must await this RPC; never abort an in-flight atomic commit.
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, target); break } catch (error) {
          if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
          await delay(100 * 2 ** attempt)
        }
      }
    } finally { await unlink(temporary).catch(() => undefined) }
    return { saved: true }
  }
}
