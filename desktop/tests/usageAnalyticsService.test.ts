import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UsageAnalyticsService } from '../src/main/usageAnalyticsService'
import type { CopilotixTask } from '@shared/types'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('UsageAnalyticsService', () => {
  it('aggregates document activity, parsed pages, and provider tokens by local day', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'copilotix-usage-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'usage.json')
    const service = new UsageAnalyticsService(path)
    const task = fixtureTask('doc-1', '2026-09-19T04:00:00.000Z')

    await service.recordDocumentPages(task.id, task.createdAt, 14)
    await service.recordTokens('deepseek', { promptTokens: 7, completionTokens: 3, totalTokens: 10 }, new Date(2026, 8, 19, 15))
    await service.recordTokens('qwen', { promptTokens: 12, completionTokens: 8, totalTokens: 20 }, new Date(2026, 8, 19, 16))

    const result = await service.snapshot([task], 3, new Date(2026, 8, 20, 12))
    const active = result.days.find((day) => day.date === '2026-09-19')
    expect(active).toEqual({ date: '2026-09-19', documents: 1, pages: 14, deepseekTokens: 10, qwenTokens: 20 })

    const reloaded = new UsageAnalyticsService(path)
    const persisted = await reloaded.snapshot([task], 3, new Date(2026, 8, 20, 12))
    expect(persisted.days.find((day) => day.date === '2026-09-19')).toEqual(active)
  })

  it('replaces the recorded page count for a retried document instead of double-counting it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'copilotix-usage-'))
    temporaryDirectories.push(directory)
    const service = new UsageAnalyticsService(join(directory, 'usage.json'))
    const task = fixtureTask('doc-2', '2026-09-20T04:00:00.000Z')

    await service.recordDocumentPages(task.id, task.createdAt, 8)
    await service.recordDocumentPages(task.id, task.createdAt, 9)

    const result = await service.snapshot([task], 1, new Date(2026, 8, 20, 12))
    expect(result.days[0]).toMatchObject({ documents: 1, pages: 9 })
  })
})

function fixtureTask(id: string, createdAt: string): CopilotixTask {
  return {
    id,
    originalName: `${id}.pdf`,
    title: null,
    name: `${id}.pdf`,
    sourcePath: `C:\\documents\\${id}.pdf`,
    sourceHash: `${id}-hash`,
    outputDir: `C:\\output\\${id}`,
    status: 'completed',
    progress: 100,
    translationProvider: 'qwen',
    remoteBatchId: null,
    remoteDataId: null,
    remoteResultUrl: null,
    error: null,
    createdAt,
    updatedAt: createdAt
  }
}
