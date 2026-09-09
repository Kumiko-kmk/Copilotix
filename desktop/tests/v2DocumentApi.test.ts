import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { V2Database } from '../src/utility/core/persistence/v2Database'
import { CompatDomainError, V2TaskRepositoryCompat } from '../src/utility/core/persistence/v2TaskRepositoryCompat'
import type { CopilotixTask } from '@shared/types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  root: string
  database: V2Database
  repository: V2TaskRepositoryCompat
  task: CopilotixTask
}> {
  const root = await mkdtemp(join(tmpdir(), 'copilotix-v2-document-api-'))
  roots.push(root)
  const outputDir = join(root, 'documents-v2', '11111111-1111-4111-8111-111111111111')
  await mkdir(outputDir, { recursive: true })
  const database = new V2Database(join(root, 'copilotix-desktop-v2.sqlite3'))
  const repository = new V2TaskRepositoryCompat(database)
  const now = '2026-01-01T00:00:00.000Z'
  const task: CopilotixTask = {
    id: '11111111-1111-4111-8111-111111111111',
    originalName: 'paper.pdf',
    title: null,
    name: 'paper.pdf',
    sourcePath: join(outputDir, 'original.pdf'),
    sourceHash: 'source-hash',
    outputDir,
    status: 'parsing',
    progress: 10,
    translationProvider: 'qwen',
    remoteBatchId: null,
    remoteDataId: null,
    remoteResultUrl: null,
    error: null,
    createdAt: now,
    updatedAt: now
  }
  repository.insertTask(task)
  repository.recordArtifactRevision(task.id, 'parsed_markdown', join(outputDir, 'full.md'), 'parsed-hash')
  return { root, database, repository, task }
}

function annotation(documentId: string, artifactId: string, id = '33333333-3333-4333-8333-333333333333') {
  return {
    id,
    documentId,
    artifactId,
    view: 'original' as const,
    kind: 'highlight' as const,
    color: 'yellow' as const,
    blockKey: 'content:0',
    startOffset: 0,
    endOffset: 5,
    quote: 'alpha',
    prefix: '',
    suffix: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('v2 document projections and annotation CAS', () => {
  it('projects document summaries without local path fields', async () => {
    const value = await fixture()
    try {
      const summary = value.repository.getDocumentSummary(value.task.id)
      expect(summary).toMatchObject({
        id: value.task.id,
        originalName: 'paper.pdf',
        workflow: { status: 'parsing', progress: 10, activeJobKind: 'parse' },
        processing: { translationProvider: 'qwen' }
      })
      expect(summary).not.toHaveProperty('sourcePath')
      expect(summary).not.toHaveProperty('outputDir')
    } finally {
      value.repository.close()
    }
  })

  it('reads and mutates only changed annotations with compare-and-swap revisioning', async () => {
    const value = await fixture()
    try {
      const artifact = value.repository.getLatestArtifactReference(value.task.id, 'parsed_markdown')
      expect(artifact).not.toBeNull()
      const artifactId = artifact!.id
      const empty = value.repository.listDocumentAnnotations({ documentId: value.task.id, view: 'original' })
      expect(empty).toMatchObject({ documentId: value.task.id, artifactId, view: 'original', revision: 0, annotations: [] })

      const first = annotation(value.task.id, artifactId)
      const saved = value.repository.mutateDocumentAnnotations({
        documentId: value.task.id,
        artifactId,
        view: 'original',
        expectedRevision: 0,
        upserts: [first],
        deleteIds: []
      })
      expect(saved).toMatchObject({ revision: 1, annotations: [first] })

      const second = annotation(value.task.id, artifactId, '44444444-4444-4444-8444-444444444444')
      const changed = value.repository.mutateDocumentAnnotations({
        documentId: value.task.id,
        artifactId,
        view: 'original',
        expectedRevision: 1,
        upserts: [{ ...first, quote: 'ALPHA', endOffset: 5 }, second],
        deleteIds: []
      })
      expect(changed.revision).toBe(2)
      expect(changed.annotations.map((item) => item.id)).toEqual([first.id, second.id])

      const deleted = value.repository.mutateDocumentAnnotations({
        documentId: value.task.id,
        artifactId,
        view: 'original',
        expectedRevision: 2,
        upserts: [],
        deleteIds: [first.id]
      })
      expect(deleted).toMatchObject({ revision: 3, annotations: [second] })
      expect(() => value.repository.mutateDocumentAnnotations({
        documentId: value.task.id,
        artifactId,
        view: 'original',
        expectedRevision: 2,
        upserts: [],
        deleteIds: []
      })).toThrow(CompatDomainError)
      let conflict: unknown
      try {
        value.repository.mutateDocumentAnnotations({
          documentId: value.task.id,
          artifactId,
          view: 'original',
          expectedRevision: 2,
          upserts: [],
          deleteIds: []
        })
      } catch (error) {
        conflict = error
      }
      expect(conflict).toMatchObject({ code: 'ANNOTATION_CONFLICT' })
    } finally {
      value.repository.close()
    }
  })

  it('rejects a cross-set annotation ID instead of overwriting concurrent data', async () => {
    const value = await fixture()
    try {
      const artifact = value.repository.getLatestArtifactReference(value.task.id, 'parsed_markdown')!
      const first = annotation(value.task.id, artifact.id)
      value.repository.mutateDocumentAnnotations({
        documentId: value.task.id,
        artifactId: artifact.id,
        view: 'original',
        expectedRevision: 0,
        upserts: [first],
        deleteIds: []
      })
      value.repository.updateTask(value.task.id, { status: 'translating', progress: 45 })
      value.repository.recordArtifactRevision(value.task.id, 'translated_markdown', join(value.task.outputDir, 'full.zh-CN.md'), 'translated-hash')
      const translatedArtifact = value.repository.getLatestArtifactReference(value.task.id, 'translated_markdown')!
      const translated = {
        ...first,
        documentId: value.task.id,
        artifactId: translatedArtifact.id,
        view: 'translated' as const
      }
      try {
        value.repository.mutateDocumentAnnotations({
          documentId: value.task.id,
          artifactId: translatedArtifact.id,
          view: 'translated',
          expectedRevision: 0,
          upserts: [translated],
          deleteIds: []
        })
      } catch (error) {
        expect(error).toMatchObject({ code: 'ANNOTATION_CONFLICT' })
      }
    } finally {
      value.repository.close()
    }
  })
})
