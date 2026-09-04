import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BLOCK_MAPPING_VERSION } from '@core/blockMapping'
import type { TranslationBatchCommit } from '@core/types'
import type { MinerUTask } from '@shared/types'
import { flattenSegments, TRANSLATION_PIPELINE_VERSION, type TableTranslationRequest } from '@shared/translationPlanProtocol'
import { MarkdownTranslationPlanManager } from '../src/utility/core/compute/markdownTranslationPlan'
import { V2Database } from '../src/utility/core/persistence/v2Database'
import { V2TaskRepositoryCompat } from '../src/utility/core/persistence/v2TaskRepositoryCompat'
import { PathPolicy } from '../src/utility/core/persistence/pathPolicy'

const TASK_ID = '11111111-1111-4111-8111-111111111111'
const roots: string[] = []

interface Fixture {
  root: string
  outputDir: string
  database: V2Database
  repository: V2TaskRepositoryCompat
  task: MinerUTask
  jobId: string
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createFixture(markdown: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'mineru-translation-plan-'))
  roots.push(root)
  const outputDir = join(root, 'document')
  await mkdir(outputDir, { recursive: true })
  await writeFile(join(outputDir, 'full.md'), markdown, 'utf8')
  await writeFile(join(outputDir, 'block_list.json'), JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings: [] }), 'utf8')

  const database = new V2Database(join(root, 'mineru-desktop-v2.sqlite3'))
  const repository = new V2TaskRepositoryCompat(database)
  const now = '2026-01-01T00:00:00.000Z'
  const task: MinerUTask = {
    id: TASK_ID,
    originalName: 'paper.pdf',
    title: null,
    name: 'paper.pdf',
    sourcePath: join(outputDir, 'original.pdf'),
    sourceHash: 'fixture-source-hash',
    outputDir,
    status: 'uploading',
    progress: 0,
    parserModel: 'vlm',
    translationProvider: 'qwen',
    remoteBatchId: null,
    remoteDataId: null,
    remoteResultUrl: null,
    error: null,
    createdAt: now,
    updatedAt: now
  }
  repository.insertTask(task)
  repository.updateTask(task.id, { status: 'translating', progress: 0 })
  const row = database.connection.prepare(
    "SELECT id FROM jobs WHERE document_id=? AND kind='translate'"
  ).get(task.id) as { id: string } | undefined
  if (!row) throw new Error('fixture translate job was not created')
  return { root, outputDir, database, repository, task, jobId: row.id }
}

function absolutePath(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'))
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, 'utf8')) as any
}

function closeFixture(fixture: Fixture): void {
  fixture.repository.close()
}

describe('utility markdown translation plan manager', () => {
  it('keeps descriptors metadata-only and stores request bodies on disk', async () => {
    const fixture = await createFixture('# Hello\n\nUse `KEEP` and **world**\n')
    try {
      const manager = new MarkdownTranslationPlanManager(fixture.repository)
      const opened = await manager.open(fixture.task.id, fixture.jobId)
      const work = await manager.listWork(fixture.task.id, fixture.jobId)
      expect(opened.reused).toBe(false)
      expect(work.items.length).toBeGreaterThan(0)

      const descriptor = work.items.find((item) => item.kind === 'plain')!
      expect(descriptor).toBeDefined()
      expect(descriptor).not.toHaveProperty('sourceMarkdown')
      expect(descriptor).not.toHaveProperty('segments')
      expect(JSON.stringify(descriptor)).not.toContain('Hello')
      expect(descriptor.requestPath).toMatch(/^\.translation\/[0-9a-f-]+\/requests\/[0-9a-f-]+\.json$/iu)

      const request = await readJson(absolutePath(fixture.outputDir, descriptor.requestPath))
      expect(request.segments.length).toBeGreaterThan(0)
      expect(request.segments.some((segment: { text: string }) => segment.text.includes('KEEP'))).toBe(false)
      const planText = await readFile(absolutePath(fixture.outputDir, `.translation/${fixture.jobId}/plan.json`), 'utf8')
      expect(planText).not.toContain('Hello')
      expect(planText).not.toContain('world')
    } finally {
      closeFixture(fixture)
    }
  })

  it('applies a response and a fresh manager resumes the completed unit', async () => {
    const fixture = await createFixture('# Hello\n')
    try {
      const manager = new MarkdownTranslationPlanManager(fixture.repository)
      await manager.open(fixture.task.id, fixture.jobId)
      const firstWork = await manager.listWork(fixture.task.id, fixture.jobId)
      const descriptor = firstWork.items[0]!
      const request = await readJson(absolutePath(fixture.outputDir, descriptor.requestPath))
      const response = {
        protocol: 'mineru-translation-plain-v1',
        unitId: request.unitId,
        sourceHash: request.sourceHash,
        translations: request.segments.map((segment: { id: string }) => ({ id: segment.id, text: '你好' }))
      }
      await writeFile(absolutePath(fixture.outputDir, descriptor.responsePath), `${JSON.stringify(response)}\n`, 'utf8')

      await expect(manager.apply(fixture.task.id, fixture.jobId, descriptor.unitId, descriptor.responsePath, 'qwen', 'fixture'))
        .resolves.toMatchObject({ unitId: descriptor.unitId, status: 'completed' })

      const resumed = new MarkdownTranslationPlanManager(fixture.repository)
      await expect(resumed.open(fixture.task.id, fixture.jobId)).resolves.toMatchObject({ reused: true, completed: 1, failed: 0 })
      const resumedWork = await resumed.listWork(fixture.task.id, fixture.jobId)
      expect(resumedWork.items[0]).toMatchObject({ unitId: descriptor.unitId, status: 'completed' })
      expect(await readFile(absolutePath(fixture.outputDir, descriptor.resultPath), 'utf8')).toContain('你好')
    } finally {
      closeFixture(fixture)
    }
  })

  it('round-trips table rowspan, colspan, and an empty cell', async () => {
    const fixture = await createFixture(
      '<table><tbody><tr><th rowspan="2">Head</th><td colspan="2">Value</td></tr><tr><td></td><td>Other</td></tr></tbody></table>\n'
    )
    try {
      const manager = new MarkdownTranslationPlanManager(fixture.repository)
      await manager.open(fixture.task.id, fixture.jobId)
      const descriptor = (await manager.listWork(fixture.task.id, fixture.jobId)).items[0]!
      expect(descriptor.kind).toBe('table')
      const request = await readJson(absolutePath(fixture.outputDir, descriptor.requestPath)) as TableTranslationRequest
      const cells = request.tables[0]!.rows.flat()
      expect(cells).toEqual(expect.arrayContaining([
        expect.objectContaining({ tag: 'th', row: 0, column: 0, rowspan: 2, colspan: 1 }),
        expect.objectContaining({ tag: 'td', row: 0, column: 1, rowspan: 1, colspan: 2 }),
        expect.objectContaining({ tag: 'td', row: 1, column: 1, segments: [] })
      ]))
      const response = {
        protocol: 'mineru-table-translation-v2',
        translations: flattenSegments(request).map((segment) => ({ id: segment.id, text: `译:${segment.text}` }))
      }
      await writeFile(absolutePath(fixture.outputDir, descriptor.responsePath), `${JSON.stringify(response)}\n`, 'utf8')
      await expect(manager.apply(fixture.task.id, fixture.jobId, descriptor.unitId, descriptor.responsePath, 'qwen', 'fixture'))
        .resolves.toMatchObject({ status: 'completed' })

      const result = await readFile(absolutePath(fixture.outputDir, descriptor.resultPath), 'utf8')
      expect(result).toContain('rowspan="2"')
      expect(result).toContain('colspan="2"')
      expect(result).toContain('<td></td>')
      expect(result).toContain('译:Head')
      expect(result).toContain('译:Value')
      expect(result).toContain('译:Other')
    } finally {
      closeFixture(fixture)
    }
  })

  it('keeps failed units on same-attempt restart and resets them after manual retry', async () => {
    const fixture = await createFixture('# Retry me\n')
    try {
      const manager = new MarkdownTranslationPlanManager(fixture.repository)
      await manager.open(fixture.task.id, fixture.jobId)
      const descriptor = (await manager.listWork(fixture.task.id, fixture.jobId)).items[0]!
      await expect(manager.fail(fixture.task.id, fixture.jobId, descriptor.unitId, 'provider crashed'))
        .resolves.toMatchObject({ unitId: descriptor.unitId, status: 'failed' })

      const sameAttempt = new MarkdownTranslationPlanManager(fixture.repository)
      await expect(sameAttempt.open(fixture.task.id, fixture.jobId)).resolves.toMatchObject({ reused: true, failed: 1 })
      expect((await sameAttempt.listWork(fixture.task.id, fixture.jobId)).items[0]).toMatchObject({ status: 'failed' })

      fixture.database.connection.prepare('UPDATE jobs SET attempt=attempt+1 WHERE id=?').run(fixture.jobId)
      expect((await manager.listWork(fixture.task.id, fixture.jobId)).items[0]).toMatchObject({ status: 'pending' })
      expect(await readJson(absolutePath(fixture.outputDir, `.translation/${fixture.jobId}/plan.json`)))
        .toMatchObject({ attempt: 1, units: [expect.objectContaining({ unitId: descriptor.unitId, status: 'pending' })] })
    } finally {
      closeFixture(fixture)
    }
  })

  it('writes the legacy cache key and dynamically splits UTF-8 translation batches', async () => {
    const fixture = await createFixture('# Hello\n')
    try {
      const commits: TranslationBatchCommit[] = []
      const commit = fixture.repository.commitTranslationBatch.bind(fixture.repository)
      fixture.repository.commitTranslationBatch = (input) => {
        commits.push(input)
        commit(input)
      }
      const manager = new MarkdownTranslationPlanManager(fixture.repository)
      await manager.open(fixture.task.id, fixture.jobId)
      const descriptor = (await manager.listWork(fixture.task.id, fixture.jobId)).items[0]!
      const request = await readJson(absolutePath(fixture.outputDir, descriptor.requestPath))
      await writeFile(absolutePath(fixture.outputDir, descriptor.responsePath), `${JSON.stringify({
        protocol: 'mineru-translation-plain-v1',
        unitId: request.unitId,
        sourceHash: request.sourceHash,
        translations: request.segments.map((segment: { id: string }) => ({ id: segment.id, text: '你好' }))
      })}\n`, 'utf8')
      await manager.apply(fixture.task.id, fixture.jobId, descriptor.unitId, descriptor.responsePath, 'qwen', 'fixture')

      const legacyKey = createHash('sha256')
        .update(`${TRANSLATION_PIPELINE_VERSION}|qwen|fixture|zh-CN|${descriptor.sourceHash}`)
        .digest('hex')
      expect(commits[0]?.cacheEntries[0]?.cacheKey).toBe(legacyKey)
      expect(commits[0]?.cacheEntries[0]?.cacheKey).not.toContain(':')
      expect(commits[0]?.cacheEntries[0]?.translated)
        .toBe(await readFile(absolutePath(fixture.outputDir, descriptor.resultPath), 'utf8'))

      const internal = manager as unknown as {
        commitTranslationBatches(input: TranslationBatchCommit): Promise<void>
      }
      const dynamicStart = commits.length
      await internal.commitTranslationBatches({
        taskId: fixture.task.id,
        jobId: fixture.jobId,
        blocks: Array.from({ length: 40 }, (_, index) => ({
          blockId: `dynamic-block-${index}`,
          sourceHash: 'a'.repeat(64),
          sourceMarkdown: '界'.repeat(6_000),
          translatedMarkdown: null,
          provider: null,
          model: null,
          status: 'pending' as const,
          error: null
        })),
        cacheEntries: [],
        checkpoint: { totalBlocks: 40, completedBlocks: 0, failedBlocks: 0, failedBlockIds: [] }
      })
      const dynamicCommits = commits.slice(dynamicStart)
      expect(dynamicCommits.length).toBeGreaterThan(1)
      expect(dynamicCommits.every((batch) => batch.blocks.length <= 32 &&
        new TextEncoder().encode(JSON.stringify(batch)).byteLength <= 768 * 1024)).toBe(true)
    } finally {
      closeFixture(fixture)
    }
  })

  it('rejects a storage path outside the configured output root', async () => {
    const fixture = await createFixture('# Confined\n')
    try {
      const configuredRoot = join(fixture.root, 'configured-output')
      const manager = new MarkdownTranslationPlanManager(fixture.repository, new PathPolicy(), { outputRoot: configuredRoot })
      await expect(manager.open(fixture.task.id, fixture.jobId)).rejects.toThrow()
      await expect(readFile(join(configuredRoot, 'documents-v2', fixture.task.id, 'full.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      closeFixture(fixture)
    }
  })
})
