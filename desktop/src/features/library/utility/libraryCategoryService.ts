import { createHash } from 'node:crypto'
import { LIBRARY_CATEGORY_PAGE_SIZE, type LibraryCategoriesPage } from '../contract/libraryCategories'
import type { DocumentSummary } from '@shared/ipcSchemas'
import { categoryTerms, classifyLibrary, type CategorySource, type ClassifiedCategory } from './libraryCategories'

export interface CategoryStore {
  categoryMeta(documentId: string): Promise<{ revision: string; readable: boolean; area: string | null }>
  categoryText(documentId: string, signal: AbortSignal): Promise<string | null>
}

type Result = {
  revision: string
  categories: ClassifiedCategory[]
  items: LibraryCategoriesPage['items']
}

/**
 * Serves library categories page by page. Term counts are cached per paper and text revision for
 * the life of the Utility process, so after the first request only changed papers are re-read; the
 * grouping itself is recomputed only when a paper, its text or its file card changes.
 */
export class LibraryCategoryService {
  private readonly terms = new Map<string, { revision: string; terms: Map<string, number> | null }>()
  private last: Result | null = null
  private source: unknown = null

  constructor(
    private readonly store: () => CategoryStore,
    private readonly documents: () => { listDocumentSummaries(): DocumentSummary[] }
  ) {}

  async page(after: number, signal: AbortSignal): Promise<LibraryCategoriesPage> {
    // Later pages of a revision are served from the result the first page computed.
    const result = after > 0 && this.last ? this.last : await this.compute(signal)
    const items = result.items.slice(after, after + LIBRARY_CATEGORY_PAGE_SIZE)
    const next = after + items.length < result.items.length ? after + items.length : null
    return {
      revision: result.revision,
      categories: result.categories.map((category) => ({ id: category.id, name: category.name, named: category.named, size: category.paperIds.length })),
      items,
      next
    }
  }

  private async compute(signal: AbortSignal): Promise<Result> {
    const repository = this.documents()
    // A different library (after maintenance) starts with an empty cache.
    if (repository !== this.source) {
      this.source = repository
      this.terms.clear()
      this.last = null
    }
    const store = this.store()
    const summaries = repository.listDocumentSummaries()
    const sources: CategorySource[] = []
    const fingerprint = createHash('sha256')
    for (const summary of summaries) {
      signal.throwIfAborted()
      const meta = await store.categoryMeta(summary.id).catch(() => ({ revision: 'unreadable', readable: false, area: null }))
      let cached = this.terms.get(summary.id)
      if (!cached || cached.revision !== meta.revision) {
        const text = meta.readable ? await store.categoryText(summary.id, signal).catch(() => null) : null
        cached = { revision: meta.revision, terms: text ? categoryTerms(text) : null }
        this.terms.set(summary.id, cached)
      }
      fingerprint.update(`${summary.id}|${meta.revision}|${meta.area ?? ''}\n`)
      sources.push({ id: summary.id, createdAt: summary.createdAt, terms: cached.terms, area: meta.area })
    }
    const ids = new Set(summaries.map((summary) => summary.id))
    for (const id of this.terms.keys()) if (!ids.has(id)) this.terms.delete(id)
    const revision = fingerprint.digest('hex').slice(0, 16)
    if (this.last?.revision === revision) return this.last
    const categories = classifyLibrary(sources)
    const items = categories.flatMap((category, index) => category.paperIds.map((documentId, rank) => ({ documentId, category: index, rank })))
    this.last = { revision, categories, items }
    return this.last
  }
}
