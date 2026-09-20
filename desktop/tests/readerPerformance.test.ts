// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { readerFootprint, readerPerformanceSnapshot, recordReaderDuration } from '../src/renderer/readerPerformance'

describe('reader performance instrumentation', () => {
  it('reports bounded duration summaries with p95 values', () => {
    let now = 100
    vi.spyOn(performance, 'now').mockImplementation(() => now++)
    for (let index = 0; index < 150; index += 1) recordReaderDuration('minimap-measure', 0)
    const summary = readerPerformanceSnapshot()['minimap-measure']
    expect(summary.count).toBe(120)
    expect(summary.p95Ms).toBeGreaterThan(0)
    expect(summary.maximumMs).toBeGreaterThanOrEqual(summary.p95Ms)
  })

  it('counts the live reader DOM and canvas footprint', () => {
    const root = document.createElement('div')
    root.innerHTML = '<div class="pdf-page"><canvas></canvas></div><div class="pdf-page"><canvas></canvas></div><article><p>text</p></article>'
    expect(readerFootprint(root)).toEqual({ domNodes: 6, canvases: 2, renderedPdfPages: 2 })
  })
})
