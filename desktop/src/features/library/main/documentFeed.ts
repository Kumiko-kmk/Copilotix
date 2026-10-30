import { randomUUID } from 'node:crypto'
import { createCoalescedRefresh } from '@platform/jobs/main/coalescedRefresh'
import type { DocumentChangeEvent, DocumentMutation, DocumentSummary, DocumentListSnapshot } from '../contract/documentSchemas'
import type { TaskRepositoryCompat } from '../contract/taskRepository'
/** Main's ordered projection. Normal updates query only the affected document IDs. */
export class DocumentFeed {
  private summaries = new Map<string, DocumentSummary>()
  private revision = 0
  private sessionId = randomUUID()
  private loaded = false
  private pending = new Map<string, DocumentMutation[]>()
  private fullRefresh = false
  readonly refresh: (change?: DocumentMutation) => void
  constructor(private readonly repository: Pick<TaskRepositoryCompat, 'listDocumentSummaries'> & Partial<Pick<TaskRepositoryCompat, 'getDocumentSummary'>>,
    emit: (event: DocumentChangeEvent) => void, onRefreshError: () => void) {
    const flush = createCoalescedRefresh(async () => {
      const pending = this.pending
      this.pending = new Map()
      const full = this.fullRefresh
      this.fullRefresh = false
      try {
        let rows: Array<[string, DocumentSummary | null]>
        if (full) {
          const all = await this.repository.listDocumentSummaries()
          const ids = new Set(all.map(row => row.id))
          rows = [...all.map(row => [row.id, row] as [string, DocumentSummary]), ...[...this.summaries.keys()].filter(id => !ids.has(id)).map(id => [id, null] as [string, null])]
        } else {
          if (!this.repository.getDocumentSummary) throw new Error('增量摘要接口不可用')
          rows = []
          for (const id of pending.keys()) rows.push([id, await this.repository.getDocumentSummary(id)])
        }
        let event: DocumentChangeEvent = this.emptyEvent()
        let bytes = 0
        const publish = () => {
          if (!event.upserted.length && !event.removedIds.length) return
          event.revision = ++this.revision
          emit(event)
          event = this.emptyEvent(); bytes = 0
        }
        for (const [id, row] of rows) {
          const mutations = pending.get(id) ?? [{ documentId: id, kind: row ? 'metadata' : 'delete' } as DocumentMutation]
          if (!pending.has(id) && JSON.stringify(row) === JSON.stringify(this.summaries.get(id) ?? null)) continue
          if (row?.contentVersions) {
            row.contentVersions.edit = mutations.find(m => m.kind === 'edit')?.version ?? this.summaries.get(id)?.contentVersions?.edit
            for (const mutation of mutations) {
              if (mutation.kind === 'body') mutation.version = row.contentVersions.body
              if (mutation.kind === 'translation') mutation.version = row.contentVersions.translation
            }
          }
          const size = Buffer.byteLength(JSON.stringify(row)) + 2048
          if (event.upserted.length + event.removedIds.length >= 100 || bytes + size > 512 * 1024) publish()
          bytes += size
          if (row) { this.summaries.set(id, row); event.upserted.push(row) }
          else { this.summaries.delete(id); event.removedIds.push(id) }
          event.changes!.push({ documentId: id, kinds: [...new Set(mutations.map(m => m.kind))], versions: Object.fromEntries(mutations.filter(m => m.version !== undefined).map(m => [m.kind, m.version!])) })
        }
        publish()
      } catch (error) {
        // Do not lose dirty IDs; the next event or explicit resync retries them.
        for (const [id, changes] of pending) this.pending.set(id, [...changes, ...(this.pending.get(id) ?? [])])
        this.fullRefresh ||= full
        throw error
      }
    }, onRefreshError)
    this.refresh = change => {
      if (change) this.pending.set(change.documentId, [...(this.pending.get(change.documentId) ?? []).filter(m => m.kind !== change.kind), change])
      else this.fullRefresh = true // Explicit recovery only; all ordinary callers supply an ID.
      flush()
    }
  }
  private emptyEvent(): DocumentChangeEvent { return { sessionId: this.sessionId, revision: this.revision + 1, upserted: [], removedIds: [], changes: [] } }
  async load(): Promise<void> {
    this.summaries = new Map((await this.repository.listDocumentSummaries()).map(summary => [summary.id, summary]))
    this.sessionId = randomUUID(); this.revision = 0; this.loaded = true
  }
  async list(): Promise<DocumentSummary[]> { if (!this.loaded) await this.load(); return [...this.summaries.values()] }
  async snapshot(): Promise<DocumentListSnapshot> {
    if (!this.loaded) await this.load()
    return { sessionId: this.sessionId, revision: this.revision, documents: [...this.summaries.values()] }
  }
}
