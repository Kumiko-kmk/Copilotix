import { createCoalescedRefresh } from '@platform/jobs/main/coalescedRefresh'
import type { DocumentChangeEvent, DocumentSummary } from '@shared/ipcSchemas'
import { computeDocumentChange } from './documentProjection'
import type { TaskRepositoryCompat } from '../contract/taskRepository'

/**
 * The document list the renderer sees: one cached snapshot plus ordered,
 * revisioned change events. Job progress can fire many changes per second, so
 * refreshes collapse into at most one in-flight and one trailing summary read.
 */
export class DocumentFeed {
  private summaries = new Map<string, DocumentSummary>()
  private revision = 0
  /** Schedules a coalesced re-read of the summaries and emits the difference. */
  readonly refresh: () => void

  constructor(
    private readonly repository: Pick<TaskRepositoryCompat, 'listDocumentSummaries'>,
    emit: (event: DocumentChangeEvent) => void,
    onRefreshError: () => void
  ) {
    this.refresh = createCoalescedRefresh(async () => {
      const current = await this.repository.listDocumentSummaries()
      const computation = computeDocumentChange(this.summaries, current, this.revision)
      this.summaries = computation.next
      if (computation.event) {
        this.revision = computation.event.revision
        emit(computation.event)
      }
    }, onRefreshError)
  }

  async load(): Promise<void> {
    this.summaries = new Map((await this.repository.listDocumentSummaries()).map((summary) => [summary.id, summary] as const))
    this.revision = 0
  }

  async list(): Promise<DocumentSummary[]> {
    if (this.summaries.size === 0) {
      const current = await this.repository.listDocumentSummaries()
      this.summaries = new Map(current.map((summary) => [summary.id, summary] as const))
    }
    return [...this.summaries.values()]
  }
}
