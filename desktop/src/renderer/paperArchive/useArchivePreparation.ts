import React from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PaperInsightSource, PaperInsightState } from '@shared/paperInsight'
import { buildReaderFigureGeometries, type ReaderFigureGeometry } from '@shared/readerFigureGroups'
import type { ArchivePaper } from './archiveShelves'

/**
 * Figure crops, PDF rendering and the cover are heavy main-thread work; they start only once the
 * selection rests, so papers passed while browsing cost nothing (browsing used 4x the CPU without it).
 */
const PREPARE_DWELL_MS = 400

/**
 * What the archive still waits for: the paper's processing, its analysis, or figures and cover. The
 * figures step is reported only while something is actually rendered from the PDF; checking caches
 * after each switch (and the selection dwell) stays silent, so prepared papers never flash it.
 */
export type ArchivePreparationStep = 'workflow' | 'analysis' | 'analysis-failed' | 'figures' | null

/** Readiness includes the saved analysis and complete figure files, not just translation. */
export function useArchivePreparation(paper: ArchivePaper | null, source?: PaperInsightSource): { ready: boolean; progress: number; waiting: ArchivePreparationStep } {
  const id = paper?.id
  const status = paper?.workflow.status
  const [restingId, setRestingId] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!id) return
    const timer = window.setTimeout(() => setRestingId(id), PREPARE_DWELL_MS)
    return () => window.clearTimeout(timer)
  }, [id])
  const resting = Boolean(id) && restingId === id
  const insightKey = `${id ?? ''}:${status ?? ''}`
  const [insight, setInsight] = React.useState<{ key: string; state: PaperInsightState } | null>(null)
  React.useEffect(() => {
    if (!id || !source) return
    let current = true, updated = false
    const accept = (state: PaperInsightState): void => { if (current) setInsight({ key: insightKey, state }) }
    const stop = source.subscribe((documentId, state) => { if (documentId === id) { updated = true; accept(state) } })
    source.get(id).then(state => { if (!updated) accept(state) }, () => accept({ status: 'failed', error: '无法读取档案' }))
    return () => { current = false; stop() }
  }, [id, source, insightKey])

  const details = useQuery({ queryKey: ['document', id], queryFn: () => window.copilotix.getDocument(id!),
    enabled: resting && ['translating', 'partial', 'completed'].includes(status ?? ''), staleTime: 30_000 })
  const data = details.data
  const geometryJson = React.useMemo(() => resting && data?.markdown.trim()
    ? JSON.stringify(buildReaderFigureGeometries(data.mappings, data.layoutJson)) : null, [resting, data?.markdown, data?.mappings, data?.layoutJson])
  const pdfUrl = data?.pdfUrl
  const figureKey = `${id ?? ''}:${pdfUrl ?? ''}:${geometryJson ?? ''}`
  const [figures, setFigures] = React.useState<{ key: string; done: boolean; ratio: number } | null>(null)
  const [renderingKey, setRenderingKey] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!id || !pdfUrl || geometryJson === null) return
    const controller = new AbortController()
    setFigures({ key: figureKey, done: false, ratio: 0 })
    if (/\.(?:md|markdown)$/iu.test(paper?.originalName ?? '')) {
      setFigures({ key: figureKey, done: true, ratio: 1 })
      return () => controller.abort()
    }
    const geometries = JSON.parse(geometryJson) as ReaderFigureGeometry[]
    void import('../useFigureArtifacts').then(({ ensureFigureArtifacts }) => ensureFigureArtifacts(id, pdfUrl, geometries, controller.signal,
      (available, failed, total) => { if (!controller.signal.aborted) setFigures({ key: figureKey, done: false, ratio: total ? (available + failed) / total : 1 }) },
      () => { if (!controller.signal.aborted) setRenderingKey(figureKey) }))
      .then(result => { if (!controller.signal.aborted) setFigures({ key: figureKey, done: result.failed === 0, ratio: result.failed ? 0.99 : 1 }) })
      .catch(() => { /* Incomplete work never unlocks the archive or produces a success check. */ })
    return () => controller.abort()
  }, [id, pdfUrl, geometryJson, figureKey, paper?.originalName])

  const state = insight?.key === insightKey ? insight.state : null
  const analysisReady = !source || (state?.status === 'ready' && !state.stale)
  const imagesReady = figures?.key === figureKey && figures.done
  const workflowReady = status === 'completed'
  const coverKey = data && id ? `${id}:${data.summary.updatedAt}:spread` : null
  const [preparedCover, setPreparedCover] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!resting || !id || !data || !coverKey || !workflowReady || !analysisReady || !imagesReady || data.summary.workflow.status !== 'completed') return
    const controller = new AbortController()
    if (/\.(?:md|markdown)$/iu.test(paper?.originalName ?? '')) {
      setPreparedCover(coverKey)
      return () => controller.abort()
    }
    void Promise.all([import('./detailPage'), import('./ArchiveDetail')])
      .then(([{ loadDetailPage, firstPageRenderer }, { renderSpread }]) => loadDetailPage(coverKey,
        () => renderSpread(id, data, firstPageRenderer(data.summary.sourceHash, () => { if (!controller.signal.aborted) setRenderingKey(coverKey) }), controller.signal, () => undefined), controller.signal))
      .then(() => { if (!controller.signal.aborted) setPreparedCover(coverKey) })
      .catch(() => { /* No completed state until the composed cover is usable. */ })
    return () => controller.abort()
  }, [resting, id, data, coverKey, workflowReady, analysisReady, imagesReady, paper?.originalName])
  const ready = Boolean(id && workflowReady && analysisReady && imagesReady && preparedCover === coverKey)
  const progress = ready ? 100 : !workflowReady ? Math.min(94, Math.max(0, (paper?.workflow.progress ?? 0) * 0.94))
    : !analysisReady ? 96 : 98 + Math.min(1, figures?.key === figureKey ? figures.ratio : 0)
  const analysisFailed = state?.status === 'failed' || state?.status === 'unavailable'
  const waiting: ArchivePreparationStep = ready ? null : !workflowReady ? 'workflow'
    : !analysisReady ? (analysisFailed ? 'analysis-failed' : 'analysis')
      : renderingKey !== null && (renderingKey === figureKey || renderingKey === coverKey) ? 'figures' : null
  return { ready, progress, waiting }
}
