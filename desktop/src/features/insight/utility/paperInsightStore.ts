import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { paperInsightRecordSchema, PAPER_INSIGHT_MAX_BYTES, type PaperInsightState } from '../contract/paperInsight'
import type { V2TaskRepositoryCompat } from '../../../utility/core/persistence/v2TaskRepositoryCompat'
import { PathPolicy } from '@platform/files/runtime/pathPolicy'
import { buildBriefContext, buildFullBriefContext, BRIEF_BUDGETS } from '../core/paperBrief/context'
import { PAPER_BRIEF_PROMPT_VERSION } from '../core/paperBrief/prompt'
import { paperBriefRecordSchema, paperBriefSaveSchema, briefContextResultSchema, briefSourceSchema, PAPER_BRIEF_MAX_BYTES, type BriefContextResult, type BriefAnchor, type BriefSource } from '../core/paperBrief/contracts'
import type { PaperBrief } from '../core/paperBrief/schema'

type Repository = Pick<V2TaskRepositoryCompat, 'getTask' | 'getLatestArtifactReference'>
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
function sameBriefSource(saved: string, current: string, language: PaperBrief['provenance']['language']): boolean {
  if (saved === current) return true
  // An analysis of original text does not become stale when its translation is published.
  if (language !== 'original') return false
  const original = saved.split('|').find(part => part.startsWith('p:'))
  return Boolean(original && original !== 'p:none' && original === current.split('|').find(part => part.startsWith('p:')))
}

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
          stale: !sameBriefSource(record.brief.provenance.sourceRevision, snapshot.sourceRevision, record.brief.provenance.language),
          promptOutdated: record.brief.provenance.promptVersion !== PAPER_BRIEF_PROMPT_VERSION }
      } catch (error) { if (!missing(error)) throw error }
      const path = join(root, 'insight.v1.json')
      const record = paperInsightRecordSchema.parse(JSON.parse(await this.read(path, PAPER_INSIGHT_MAX_BYTES)))
      this.policy.resolveChild(root, 'insight.v1.json')
      if (record.documentId !== documentId) throw new Error('解读不属于当前论文')
      return { status: 'ready', insight: record.insight, stale: record.insight.sourceRevision !== snapshot.sourceRevision }
    } catch (error) { if (missing(error)) return { status: 'missing' }; throw error }
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
    const context = buildFullBriefContext(original, translated)
    const after = await this.snapshot(documentId)
    if (after.sourceRevision !== snapshot.sourceRevision) throw new Error('论文内容正在更新，请重试')
    return briefContextResultSchema.parse({ documentId, sourceRevision: snapshot.sourceRevision, context })
  }

  async briefSource(documentId: string): Promise<BriefSource> {
    const snapshot = await this.snapshot(documentId)
    const sources: BriefSource['sources'] = []
    for (const [artifact, language] of [[snapshot.original, 'original'], [snapshot.translated, 'translated']] as const) {
      if (!artifact) continue
      const path = this.policy.resolveChild(snapshot.root, artifact.relativePath)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('论文全文来源无效或超过 16 MiB；未截断内容')
      sources.push({ path, hash: artifact.contentHash, language })
    }
    return briefSourceSchema.parse({ documentId, sourceRevision: snapshot.sourceRevision, sources })
  }

  /**
   * What library categorisation needs to know cheaply: the text revision, whether there is text
   * at all, and the field named by the paper's AI file card. A broken card only loses the name.
   */
  async categoryMeta(documentId: string): Promise<{ revision: string; readable: boolean; area: string | null }> {
    const snapshot = await this.snapshot(documentId)
    let area: string | null = null
    try {
      const state = await this.get(documentId)
      if (state.status === 'ready' && 'brief' in state) area = state.brief.field.area
    } catch { /* Uncategorised by name only; the content still counts. */ }
    return { revision: snapshot.sourceRevision, readable: Boolean(snapshot.translated ?? snapshot.original), area }
  }

  /**
   * A paper's representative text for categorisation: title plus the abstract, conclusion and most
   * informative paragraphs. The translation is preferred so a mostly translated library is compared
   * in one language.
   */
  async categoryText(documentId: string, signal: AbortSignal): Promise<string | null> {
    signal.throwIfAborted()
    const snapshot = await this.snapshot(documentId)
    const artifact = snapshot.translated ?? snapshot.original
    if (!artifact) return null
    this.policy.resolveChild(snapshot.root, artifact.relativePath)
    const markdown = await this.read(join(snapshot.root, artifact.relativePath), 32 * 1024 * 1024)
    signal.throwIfAborted()
    const context = snapshot.translated
      ? buildBriefContext('', markdown, BRIEF_BUDGETS.standard)
      : buildBriefContext(markdown, '', BRIEF_BUDGETS.standard)
    const text = [context.title ?? '', ...context.excerpts.map((excerpt) => excerpt.text)].join('\n').trim()
    return text || null
  }

  async saveBrief(documentId: string, brief: PaperBrief, anchors: BriefAnchor[]): Promise<{ saved: true }> {
    const value = paperBriefSaveSchema.parse({ documentId, brief, anchors })
    const body = JSON.stringify(paperBriefRecordSchema.parse({ version: 2, ...value }))
    return this.commit(documentId, 'brief.v2.json', body, PAPER_BRIEF_MAX_BYTES)
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
