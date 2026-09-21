import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import archiver from 'archiver'
import { afterEach, describe, expect, it } from 'vitest'
import type { Job, JobRepositoryPort } from '@core/jobs'
import type { TaskComputePort } from '@core/ports'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { CopilotixTask } from '@shared/types'
import { ParseJobRunner } from '@main/parseJobRunner'
import { PathPolicy } from '@main/pathPolicy'
import type { ParserClient } from '@main/parserClient'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('parse artifact pipeline concurrency', () => {
  it('bounds result downloads and normalization across resumed documents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-parse-pipeline-'))
    roots.push(root)
    const zip = await resultZip()
    const tasks = new Map<string, CopilotixTask>()
    const jobs: Job[] = []
    for (let index = 0; index < 4; index += 1) {
      const id = `00000000-0000-4000-8000-00000000000${index + 1}`
      const outputDir = join(root, id)
      await mkdir(outputDir, { recursive: true })
      await writeFile(join(outputDir, 'original.pdf'), '%PDF-1.4 fixture')
      tasks.set(id, task(id, outputDir))
      jobs.push(job(id, index))
    }

    let activeDownloads = 0
    let peakDownloads = 0
    let activeNormalizations = 0
    let peakNormalizations = 0
    const parserClient: ParserClient = {
      verifyToken: async () => ({ ok: true, message: 'ok' }),
      createUploadBatch: async () => { throw new Error('fresh upload is not expected') },
      uploadFile: async () => { throw new Error('fresh upload is not expected') },
      getBatchResult: async (batchId) => {
        const dataId = batchId.replace('batch-', '')
        return { batchId, entries: [{ dataId, fileName: 'paper.pdf', state: 'done', fullZipUrl: `https://example.test/${dataId}.zip`, error: null, progress: null }] }
      },
      waitForBatch: async () => { throw new Error('completed checkpoints must not poll') },
      downloadResult: async (_url, destination) => {
        activeDownloads += 1
        peakDownloads = Math.max(peakDownloads, activeDownloads)
        await delay(15)
        await writeFile(destination, zip)
        activeDownloads -= 1
      }
    }
    const compute: TaskComputePort = {
      hashFile: async () => 'a'.repeat(64),
      importPdf: async () => ({ sha256: 'a'.repeat(64), size: 0 }),
      normalizeParserOutput: async () => {
        activeNormalizations += 1
        peakNormalizations = Math.max(peakNormalizations, activeNormalizations)
        await delay(15)
        activeNormalizations -= 1
        return { normalized: true, displayTitle: null, pageCount: 1 }
      },
      rebuildMappings: async () => undefined,
      openTranslationPlan: async () => { throw new Error('unused') },
      listTranslationWork: async () => { throw new Error('unused') },
      tryTranslationCache: async () => { throw new Error('unused') },
      applyTranslation: async () => { throw new Error('unused') },
      failTranslation: async () => { throw new Error('unused') },
      finalizeTranslation: async () => { throw new Error('unused') }
    }
    const jobRepository = {
      list: async () => [],
      enqueue: async (input: { documentId: string }) => job(input.documentId, 99)
    } as unknown as JobRepositoryPort
    const runner = new ParseJobRunner({
      repository: { getTask: async (id: string) => tasks.get(id) ?? null } as never,
      jobRepository,
      settingsService: { get: async () => ({ ...DEFAULT_SETTINGS, credentials: { ...DEFAULT_SETTINGS.credentials, parser: { state: 'valid' as const } } }) } as never,
      vault: { get: async () => 'token' } as never,
      parserClient,
      compute,
      pathPolicy: new PathPolicy(),
      concurrency: { download: 1, extract: 1, normalize: 1 }
    })

    const results = await runner.runBatch({
      jobs,
      signal: new AbortController().signal,
      updateProgress: async (jobId, progress, checkpoint) => ({ ...jobs.find((candidate) => candidate.id === jobId)!, progress, checkpoint })
    })

    expect(results.every((result) => result.result?.status === 'succeeded')).toBe(true)
    expect(peakDownloads).toBe(1)
    expect(peakNormalizations).toBe(1)
  })
})

function task(id: string, outputDir: string): CopilotixTask {
  return {
    id,
    originalName: `${id}.pdf`,
    title: null,
    name: `${id}.pdf`,
    sourcePath: join(outputDir, 'original.pdf'),
    sourceHash: id,
    outputDir,
    status: 'parsing',
    progress: 10,
    translationProvider: 'qwen',
    remoteBatchId: `batch-${id}`,
    remoteDataId: id,
    remoteResultUrl: null,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

function job(documentId: string, index: number): Job {
  return {
    id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    documentId,
    kind: 'parse',
    status: 'running',
    progress: 10,
    attempt: 0,
    maxAttempts: 5,
    priority: 0,
    payload: {},
    availableAt: '2026-01-01T00:00:00.000Z',
    leaseOwner: 'test',
    leaseExpiresAt: '2026-01-01T00:01:00.000Z',
    dependsOnJobId: null,
    checkpoint: { remoteBatchId: `batch-${documentId}`, remoteDataId: documentId },
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function resultZip(): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 1 } })
    const output = new PassThrough()
    const chunks: Buffer[] = []
    output.on('data', (chunk: Buffer) => chunks.push(chunk))
    output.on('end', () => resolve(Buffer.concat(chunks)))
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    archive.append('# fixture\n', { name: 'result/full.md' })
    void archive.finalize()
  })
}
