import type {
  DocumentChangeEvent,
  DocumentDetails,
  DocumentSummary
} from '@shared/ipcSchemas'
import {
  documentChangeEventSchema,
  documentSummarySchema
} from '@shared/ipcSchemas'
import type { DocumentPayload } from '@shared/types'
import { projectDocumentSummary } from '@shared/documentSummary'

/**
 * Strip all legacy task fields, especially sourcePath/outputDir. Fields are
 * copied explicitly; the IPC handler validates the response once, so a long
 * paper's Markdown and mappings are not schema-checked twice in Main.
 */
export function projectDocumentDetails(payload: DocumentPayload): DocumentDetails {
  return {
    summary: projectDocumentSummary(payload.task),
    markdown: payload.markdown,
    translatedMarkdown: payload.translatedMarkdown,
    translatedBlocks: payload.translatedBlocks,
    layoutJson: payload.layoutJson,
    mappings: payload.mappings,
    ...(payload.markdownEdits !== undefined ? { markdownEdits: payload.markdownEdits } : {}),
    pdfUrl: payload.pdfUrl,
    assetBaseUrl: payload.assetBaseUrl
  }
}

export interface DocumentChangeComputation {
  next: Map<string, DocumentSummary>
  event: DocumentChangeEvent | null
}

/**
 * Build the small monotonic event sent after TaskService's full-list event.
 * Equality is performed on the already normalized DTO, so unchanged status
 * and metadata never produce an upsert.
 */
export function computeDocumentChange(
  previous: ReadonlyMap<string, DocumentSummary>,
  current: readonly DocumentSummary[],
  revision: number
): DocumentChangeComputation {
  const next = new Map<string, DocumentSummary>()
  for (const candidate of current) {
    const summary = documentSummarySchema.parse(candidate)
    if (next.has(summary.id)) throw new Error(`重复的文档 ID: ${summary.id}`)
    next.set(summary.id, summary)
  }

  const upserted = [...next.values()]
    .filter((candidate) => !sameSummary(previous.get(candidate.id), candidate))
  const removedIds = [...previous.keys()].filter((id) => !next.has(id))
  if (upserted.length === 0 && removedIds.length === 0) return { next, event: null }

  return {
    next,
    event: documentChangeEventSchema.parse({
      revision: revision + 1,
      upserted,
      removedIds
    })
  }
}

function sameSummary(left: DocumentSummary | undefined, right: DocumentSummary): boolean {
  return left !== undefined && JSON.stringify(documentSummarySchema.parse(left)) === JSON.stringify(right)
}
