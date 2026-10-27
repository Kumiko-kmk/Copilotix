import type { ArchiveInsightSnapshot, PaperInsightSource } from '@features/insight/contract/paperInsight'
import type { ArchivePaper } from './archiveShelves'
import { useArchiveCatalog } from './useArchiveCatalog'

export type ArchivePreparationStep = 'workflow' | 'analysis' | 'analysis-failed' | 'figures' | null

/** Access is a saved-data fact, independent of the currently selected GPU cover. */
export function archivePreparation(paper: ArchivePaper | null, saved: ArchiveInsightSnapshot | undefined, hasSource: boolean): { ready: boolean; progress: number; waiting: ArchivePreparationStep } {
  const workflowReady = paper?.workflow.status === 'completed'
  const ready = Boolean(paper && workflowReady && (!hasSource || saved?.ready))
  const progress = ready ? 100 : !workflowReady ? Math.min(94, Math.max(0, (paper?.workflow.progress ?? 0) * 0.94)) : 96
  const waiting = ready ? null : !workflowReady ? 'workflow' : saved?.savedStatus === 'failed' ? 'analysis-failed' : 'analysis'
  return { ready, progress, waiting }
}

/** Retain the hook entry for embedders; the library itself shares one catalog for every paper. */
export function useArchivePreparation(paper: ArchivePaper | null, source?: PaperInsightSource) {
  const catalog = useArchiveCatalog(paper ? [paper] : [], source)
  return archivePreparation(paper, paper ? catalog.get(paper.id) : undefined, Boolean(source))
}
