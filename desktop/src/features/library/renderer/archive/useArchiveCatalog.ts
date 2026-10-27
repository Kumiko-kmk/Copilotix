import React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ArchiveInsightSnapshot, PaperInsightSource, PaperInsightState } from '@features/insight/contract/paperInsight'
import type { DocumentSummary } from '../../contract/documentSchemas'
import { acceptArchiveInsight } from './useArchiveInsight'

type Entry = { version: string; value: ArchiveInsightSnapshot; readAt: number }
type CatalogPaper = Pick<DocumentSummary, 'id' | 'workflow' | 'createdAt'> & Partial<Pick<DocumentSummary, 'sourceHash' | 'updatedAt'>>
const catalogs = new WeakMap<PaperInsightSource, Map<string, Entry>>()
const LOCAL_PAGE_SIZE = 200

function version(paper: CatalogPaper): string {
  // Progress timestamps do not invalidate a paper that is still processing.
  return `${paper.sourceHash ?? ''}:${paper.workflow.status}:${paper.workflow.status === 'completed' ? paper.updatedAt ?? paper.createdAt : ''}`
}

function fromState(paper: CatalogPaper, state: PaperInsightState, translatedTitle = ''): ArchiveInsightSnapshot {
  const ready = state.status === 'ready'
  return {
    documentId: paper.id, updatedAt: paper.updatedAt ?? paper.createdAt, workflowStatus: paper.workflow.status,
    savedStatus: ready ? (state.stale ? 'stale' : 'ready') : state.status === 'missing' || state.status === 'generating' ? 'missing' : 'failed',
    ready: ready && !state.stale && paper.workflow.status === 'completed', translatedTitle,
    keywords: ready ? ('brief' in state ? state.brief.keywords : state.insight.keywords).slice(0, 8).map(word => word.slice(0, 80)) : [],
    tldr: ready ? ('brief' in state ? state.brief.tldr : state.insight.summary).slice(0, 120) : ''
  }
}

/** Compatibility for older embedders; the desktop uses the compact local batch API. */
async function readPage(source: PaperInsightSource, papers: CatalogPaper[]): Promise<ArchiveInsightSnapshot[]> {
  if (source.list) return source.list(papers.map(paper => paper.id))
  const rows = new Array<ArchiveInsightSnapshot>(papers.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, papers.length) }, async () => {
    for (;;) {
      const index = cursor++, paper = papers[index]
      if (!paper) return
      const state = await source.get(paper.id).catch((): PaperInsightState => ({ status: 'failed', error: '无法读取本地档案' }))
      rows[index] = fromState(paper, state)
    }
  }))
  return rows
}

/** A transient local RPC failure gets two retries; no recurring catalog polling. */
async function readSavedPage(source: PaperInsightSource, papers: CatalogPaper[], signal: AbortSignal): Promise<ArchiveInsightSnapshot[]> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    try { return await readPage(source, papers) } catch (error) {
      if (signal.aborted || attempt >= 2) throw error
      await new Promise<void>((resolve, reject) => {
        const cancel = (): void => { window.clearTimeout(timer); reject(signal.reason) }
        const timer = window.setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, attempt ? 1_500 : 500)
        signal.addEventListener('abort', cancel, { once: true })
      })
    }
  }
}

/** All navigation paths share small, saved local facts. No body, crop or GPU work happens here. */
export function useArchiveCatalog(documents: readonly CatalogPaper[], source?: PaperInsightSource): ReadonlyMap<string, ArchiveInsightSnapshot> {
  const client = useQueryClient()
  const cache = React.useMemo(() => {
    if (!source) return new Map<string, Entry>()
    let saved = catalogs.get(source)
    if (!saved) { saved = new Map(); catalogs.set(source, saved) }
    return saved
  }, [source])
  const currentDocuments = React.useRef(new Map<string, CatalogPaper>())
  currentDocuments.current = new Map(documents.map(paper => [paper.id, paper]))
  const events = React.useRef(new Map<string, number>())
  const [change, setChange] = React.useState(0)
  const revisions = documents.map(paper => `${paper.id}:${version(paper)}`).join('|')

  React.useEffect(() => {
    if (!source) return
    const controller = new AbortController()
    const pending = new Map<string, { paper: CatalogPaper; event: number }>()
    let draining = false
    const drain = async (): Promise<void> => {
      if (draining) return
      draining = true
      try {
        while (pending.size && !controller.signal.aborted) {
          const batch = [...pending.values()].slice(0, LOCAL_PAGE_SIZE)
          for (const { paper } of batch) pending.delete(paper.id)
          let rows: ArchiveInsightSnapshot[]
          try { rows = await readSavedPage(source, batch.map(item => item.paper), controller.signal) } catch { continue }
          if (controller.signal.aborted) return
          for (const row of rows) {
            const request = batch.find(item => item.paper.id === row.documentId)
            const paper = currentDocuments.current.get(row.documentId)
            if (!request || !paper || version(request.paper) !== version(paper) || events.current.get(paper.id) !== request.event) continue
            if (paper.workflow.status === 'completed' && row.updatedAt !== (paper.updatedAt ?? paper.createdAt)) continue
            cache.set(paper.id, { version: version(paper), value: row, readAt: Date.now() })
          }
          setChange(value => value + 1)
        }
      } finally { draining = false }
    }
    const stop = source.subscribe((id, state) => {
      const paper = currentDocuments.current.get(id)
      if (!paper) return
      events.current.set(id, (events.current.get(id) ?? 0) + 1)
      acceptArchiveInsight(client, id, state)
      const previous = cache.get(id)
      const same = previous?.version === version(paper)
      // A replacement generation or its failure does not remove the saved, readable card.
      const transient = ['generating', 'failed', 'unavailable'].includes(state.status)
      if (!transient) {
        cache.set(id, { version: version(paper), value: fromState(paper, state, same ? previous.value.translatedTitle : ''), readAt: Date.now() })
        setChange(value => value + 1)
      }
      // Generation state is not evidence that a saved card disappeared. Ask
      // the read-only store, including when it raced the initial catalog read.
      pending.set(id, { paper, event: events.current.get(id)! })
      void drain()
    })
    return () => { stop(); controller.abort(); pending.clear() }
  }, [source, cache, client])

  React.useEffect(() => {
    for (const id of cache.keys()) if (!currentDocuments.current.has(id)) { cache.delete(id); events.current.delete(id) }
    if (!source) return
    const controller = new AbortController()
    const papers = [...currentDocuments.current.values()].filter(paper => {
      const entry = cache.get(paper.id)
      return entry?.version !== version(paper) || Date.now() - entry.readAt > (entry.value.savedStatus === 'failed' ? 3_000 : 30_000)
    })
    void (async () => {
      for (let offset = 0; !controller.signal.aborted && offset < papers.length; offset += LOCAL_PAGE_SIZE) {
        const page = papers.slice(offset, offset + LOCAL_PAGE_SIZE)
        const eventVersions = new Map(page.map(paper => [paper.id, events.current.get(paper.id) ?? 0]))
        let rows: ArchiveInsightSnapshot[]
        try { rows = await readSavedPage(source, page, controller.signal) } catch { continue }
        if (controller.signal.aborted) return
        for (const row of rows) {
          const paper = currentDocuments.current.get(row.documentId)
          const requested = page.find(item => item.id === row.documentId)
          if (!paper || !requested || version(paper) !== version(requested) || (events.current.get(paper.id) ?? 0) !== eventVersions.get(paper.id)) continue
          if (paper.workflow.status === 'completed' && row.updatedAt !== (paper.updatedAt ?? paper.createdAt)) continue
          cache.set(paper.id, { version: version(paper), value: row, readAt: Date.now() })
        }
        setChange(value => value + 1)
      }
    })()
    return () => controller.abort()
  }, [source, cache, revisions])

  return React.useMemo(() => new Map(documents.flatMap(paper => {
    const entry = cache.get(paper.id)
    return entry?.version === version(paper) ? [[paper.id, entry.value] as const] : []
  })), [documents, cache, change])
}
