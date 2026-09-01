import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskRepository } from '../src/main/database'
import type { MinerUTask, ReaderAnnotation } from '@shared/types'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('reader annotation database', () => {
  it('persists view-isolated annotations and removes them with their task', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mineru-annotations-'))
    directories.push(directory)
    const repository = new TaskRepository(join(directory, 'database.sqlite3'))
    repository.insertTask(task())
    const original = annotation('original', 'original-id')
    const translated = annotation('translated', 'translated-id')
    repository.replaceReaderAnnotations({ taskId: 'task', view: 'original', annotations: [original] })
    repository.replaceReaderAnnotations({ taskId: 'task', view: 'translated', annotations: [translated] })
    expect(repository.listReaderAnnotations('task').map((value) => value.id)).toEqual(['original-id', 'translated-id'])

    repository.replaceReaderAnnotations({ taskId: 'task', view: 'original', annotations: [] })
    expect(repository.listReaderAnnotations('task').map((value) => value.id)).toEqual(['translated-id'])
    repository.deleteTask('task')
    expect(repository.listReaderAnnotations('task')).toEqual([])
    repository.close()
  })

  it('rejects invalid colors, offsets and cross-view records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mineru-annotations-'))
    directories.push(directory)
    const repository = new TaskRepository(join(directory, 'database.sqlite3'))
    repository.insertTask(task())
    expect(() => repository.replaceReaderAnnotations({
      taskId: 'task', view: 'original', annotations: [{ ...annotation('translated', 'bad'), startOffset: 4, endOffset: 2 }]
    })).toThrow(/标注数据无效/)
    repository.close()
  })
})

function annotation(view: 'original' | 'translated', id: string): ReaderAnnotation {
  return {
    id, taskId: 'task', view, kind: 'highlight', color: 'yellow', blockKey: 'content:0',
    startOffset: 0, endOffset: 5, quote: 'alpha', prefix: '', suffix: ' beta',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

function task(): MinerUTask {
  return {
    id: 'task', name: 'Paper', sourcePath: 'paper.pdf', sourceHash: 'hash', outputDir: 'output',
    status: 'completed', progress: 100, parserModel: 'vlm', translationProvider: 'qwen',
    remoteBatchId: null, remoteDataId: null, remoteResultUrl: null, error: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  }
}
