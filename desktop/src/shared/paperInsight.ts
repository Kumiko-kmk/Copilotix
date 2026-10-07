/**
 * AI-generated structured reading of one paper, shown in the archive detail view.
 * Contract between the renderer (implemented) and the generation pipeline (to be implemented
 * in Main/Utility, see AGENTS.md §13). Only paper content goes in; no import metadata.
 */
export interface PaperInsight {
  /** One or two sentences: what the paper does and why it matters. */
  summary: string
  researchQuestion: string
  method: string
  contributions: string[]
  findings: string[]
  limitations: string[]
  keywords: string[]
  model: { provider: 'qwen' | 'deepseek'; name: string }
  generatedAt: string
  /** Revision of the Markdown it was generated from; the insight is stale once that changes. */
  sourceRevision: string
}

export type PaperInsightState =
  | { status: 'missing' }
  | { status: 'generating' }
  | { status: 'ready'; insight: PaperInsight; stale: boolean }
  | { status: 'failed'; error: string }
  | { status: 'unavailable'; reason: string }

/** What the archive page needs; App wires it to IPC once the pipeline exists. */
export interface PaperInsightSource {
  get(documentId: string): Promise<PaperInsightState>
  generate(documentId: string): Promise<void>
  /** Push updates while generating; returns an unsubscribe function. */
  subscribe(listener: (documentId: string, state: PaperInsightState) => void): () => void
}
