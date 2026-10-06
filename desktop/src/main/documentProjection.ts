import type {
  DocumentChangeEvent,
  DocumentDetails,
  DocumentSummary
} from '@shared/ipcSchemas'
import {
  documentChangeEventSchema,
  documentSummarySchema
} from '@shared/ipcSchemas'
import type { DocumentPayload, CopilotixTask } from '@shared/types'

/**
 * Convert the temporary task projection at the application boundary.  The
 * legacy task still contains local paths, but this DTO deliberately has no
 * filesystem identity that can cross into preload/renderer.
 */
export function projectDocumentSummary(task: CopilotixTask): DocumentSummary {
  return documentSummarySchema.parse({
    id: task.id,
    originalName: task.originalName,
    displayName: task.name,
    sourceHash: task.sourceHash,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    workflow: {
      status: task.status,
      progress: task.progress,
      activeJobKind: activeJobKindFor(task.status),
      error: task.error
    },
    processing: { translationProvider: task.translationProvider }
  })
}

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

  const upserted = current
    .map((candidate) => documentSummarySchema.parse(candidate))
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
  return left !== undefined && JSON.stringify(documentSummarySchema.parse(left)) === JSON.stringify(documentSummarySchema.parse(right))
}

function activeJobKindFor(status: DocumentSummary['workflow']['status']): 'parse' | 'translate' | null {
  if (status === 'uploading' || status === 'parsing' || status === 'queued') return 'parse'
  if (status === 'translating') return 'translate'
  return null
}
