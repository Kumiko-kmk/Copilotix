import { documentSummarySchema, type DocumentSummary } from '@shared/ipcSchemas'
import type { CopilotixTask } from '@shared/types'

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
      activeJobKind: task.status === 'uploading' || task.status === 'parsing' ? 'parse' : task.status === 'translating' ? 'translate' : null,
      error: task.error
    },
    processing: { translationProvider: task.translationProvider }
  })
}
