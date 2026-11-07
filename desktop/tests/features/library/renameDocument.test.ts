import { describe, expect, it, vi } from 'vitest'
import { PathPolicy } from '../../../src/platform/files/runtime/pathPolicy'
import { TaskService } from '../../../src/features/library/main/taskService'
import { renameDocumentRequestSchema } from '../../../src/features/library/contract/documentSchemas'
import type { SettingsService } from '../../../src/features/settings/main/settingsService'
import type { TaskRepositoryCompat } from '../../../src/features/library/contract/taskRepository'
import { fixtureTaskCompute } from './taskComputeFixture'

const documentId = '00000000-0000-4000-8000-0000000000a1'

describe('renaming a paper', () => {
  it('accepts a trimmed title and rejects empty, overlong or control-character titles', () => {
    expect(renameDocumentRequestSchema.parse({ documentId, title: '  Fracture paths  ' }).title).toBe('Fracture paths')
    for (const title of ['   ', 'x'.repeat(201), 'line\nbreak', 'tab\there', 'nul\u0000']) {
      expect(renameDocumentRequestSchema.safeParse({ documentId, title }).success, JSON.stringify(title)).toBe(false)
    }
    expect(renameDocumentRequestSchema.safeParse({ documentId, title: 'ok', path: '/escape' }).success).toBe(false)
  })

  it('stores the title without the .pdf suffix and announces a metadata change', async () => {
    const updateDocumentMetadata = vi.fn(async () => undefined)
    const service = new TaskService({ updateDocumentMetadata } as unknown as TaskRepositoryCompat, {} as SettingsService, fixtureTaskCompute, new PathPolicy())
    const changed = vi.fn()
    service.on('changed', changed)
    await service.rename(documentId, ' 断裂路径.PDF ')
    expect(updateDocumentMetadata).toHaveBeenCalledWith(documentId, { displayTitle: '断裂路径' })
    expect(changed).toHaveBeenCalledWith({ documentId, kind: 'metadata' })
    await expect(service.rename(documentId, '.pdf')).rejects.toThrow('标题不能为空')
    expect(updateDocumentMetadata).toHaveBeenCalledTimes(1)
  })
})
