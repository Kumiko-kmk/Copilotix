export type ReaderPerformanceMetric = 'markdown-index' | 'minimap-measure' | 'pdf-render'

const MAX_SAMPLES_PER_METRIC = 120
const samples = new Map<ReaderPerformanceMetric, number[]>()

export function recordReaderDuration(metric: ReaderPerformanceMetric, startedAt: number): void {
  const duration = Math.max(0, performance.now() - startedAt)
  const values = samples.get(metric) ?? []
  values.push(duration)
  if (values.length > MAX_SAMPLES_PER_METRIC) values.splice(0, values.length - MAX_SAMPLES_PER_METRIC)
  samples.set(metric, values)
}
export function readerPerformanceSnapshot(): Record<ReaderPerformanceMetric, ReaderMetricSummary> {
  return {
    'markdown-index': summarize(samples.get('markdown-index') ?? []),
    'minimap-measure': summarize(samples.get('minimap-measure') ?? []),
    'pdf-render': summarize(samples.get('pdf-render') ?? [])
  }
}

export function readerFootprint(root: ParentNode): { domNodes: number; canvases: number; renderedPdfPages: number } {
  return {
    domNodes: root.querySelectorAll('*').length,
    canvases: root.querySelectorAll('canvas').length,
    renderedPdfPages: root.querySelectorAll('.pdf-page').length
  }
}

export interface ReaderMetricSummary {
  count: number
  averageMs: number
  p95Ms: number
  maximumMs: number
}

function summarize(values: readonly number[]): ReaderMetricSummary {
  if (values.length === 0) return { count: 0, averageMs: 0, p95Ms: 0, maximumMs: 0 }
  const ordered = [...values].sort((left, right) => left - right)
  const total = ordered.reduce((sum, value) => sum + value, 0)
  return {
    count: ordered.length,
    averageMs: total / ordered.length,
    p95Ms: ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)] ?? 0,
    maximumMs: ordered[ordered.length - 1] ?? 0
  }
}
