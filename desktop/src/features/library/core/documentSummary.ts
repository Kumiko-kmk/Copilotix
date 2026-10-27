import { documentSummarySchema, type DocumentSummary } from '../contract/documentSchemas'
import type { CopilotixTask } from '../contract/documentTypes'

/**
 * Convert the internal task projection into the renderer-visible summary.
 * Main and Utility share this one projection; the DTO deliberately has no
 * filesystem identity (sourcePath/outputDir) that can cross into preload/renderer.
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

function activeJobKindFor(status: DocumentSummary['workflow']['status']): 'parse' | 'translate' | null {
  if (status === 'uploading' || status === 'parsing' || status === 'queued') return 'parse'
  if (status === 'translating') return 'translate'
  return null
}
