import React from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { PaperInsightSource, PaperInsightState } from '@features/insight/contract/paperInsight'
import type { ArchivePaper } from './archiveShelves'
import { archivePaperRevision } from './archiveBrowseData'

const INSIGHT_CACHE_LIMIT = 32

function trimInsightCache(client: QueryClient): void {
  const entries = client.getQueryCache().findAll({ queryKey: ['archive-insight'] })
  const inactive = entries.filter(query => query.getObserversCount() === 0).sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt)
  let excess = entries.length - INSIGHT_CACHE_LIMIT
  for (const query of inactive) {
    if (excess-- <= 0) break
    client.removeQueries({ queryKey: query.queryKey, exact: true })
  }
}

/** A regenerating replacement does not hide the saved readable version. */
export function acceptArchiveInsight(client: QueryClient, documentId: string, state: PaperInsightState): void {
  for (const cached of client.getQueryCache().findAll({ queryKey: ['archive-insight', documentId] })) {
    void client.cancelQueries({ queryKey: cached.queryKey, exact: true })
    if (cached.state.data && (cached.state.data as PaperInsightState).status === 'ready' && ['generating', 'failed', 'unavailable'].includes(state.status)) continue
    client.setQueryData(cached.queryKey, state)
  }
}

/** Preparation, browse notes and extracted details consume one saved-state read. */
export function useArchiveInsight(paper: ArchivePaper | null, source?: PaperInsightSource) {
  const client = useQueryClient()
  const id = paper?.id
  const revision = paper ? archivePaperRevision(paper) : ''
  const key = React.useMemo(() => ['archive-insight', id, revision] as const, [id, revision])
  const query = useQuery<PaperInsightState>({
    queryKey: key,
    queryFn: async ({ signal }) => {
      try {
        const state = await (source!.readSaved ? source!.readSaved(id!) : source!.get(id!))
        signal.throwIfAborted()
        const previous = client.getQueryData<PaperInsightState>(key)
        return state.status === 'generating' && previous?.status === 'ready' ? previous : state
      } catch {
        signal.throwIfAborted()
        return { status: 'failed', error: '无法读取本地档案卡，请重试。' }
      }
    },
    enabled: Boolean(id && source), staleTime: query => query.state.data?.status === 'ready' ? 30_000 : 0, gcTime: 120_000
  })
  React.useEffect(() => {
    trimInsightCache(client)
    if (!id || !source) return
    return source.subscribe((documentId, state) => acceptArchiveInsight(client, documentId, state))
  }, [client, id, key, source])
  const state = query.data ?? null
  const saved = React.useRef<{ key: string; ready: Extract<PaperInsightState, { status: 'ready' }> } | null>(null)
  const savedKey = `${id ?? ''}:${revision}`
  if (state?.status === 'ready') saved.current = { key: savedKey, ready: state }
  return { state, ready: saved.current?.key === savedKey ? saved.current.ready : null }
}

