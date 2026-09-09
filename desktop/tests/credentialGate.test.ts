import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { AppSettings, CopilotixTask } from '@shared/types'
import type { Job } from '../src/core/jobs'
import { ParseJobRunner } from '../src/main/parseJobRunner'
import { PathPolicy } from '../src/main/pathPolicy'
import { ParserApiError } from '../src/main/parserClient'
import { TranslationJobRunner } from '../src/main/translationJobRunner'

const task: CopilotixTask = {
  id: '11111111-1111-4111-8111-111111111111',
  originalName: 'paper.pdf',
  title: null,
  name: 'paper.pdf',
  sourcePath: 'C:\\output\\paper.pdf',
  sourceHash: 'hash',
  outputDir: 'C:\\output\\paper',
  status: 'translating',
  progress: 0,
  translationProvider: 'qwen',
  remoteBatchId: null,
  remoteDataId: null,
  remoteResultUrl: null,
  error: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

const job = {
  id: '22222222-2222-4222-8222-222222222222',
  documentId: task.id,
  kind: 'translate',
  status: 'running',
  checkpoint: {}
} as unknown as Job

describe('translation credential gate', () => {
  it.each(['missing', 'unknown', 'invalid'] as const)('blocks translation when Copilotix is %s', async (state) => {
    const fetcher = vi.fn()
    const settings = appSettings({ state })
    const runner = new TranslationJobRunner({
      repository: { getTask: async () => task } as never,
      settingsService: { get: async () => settings } as never,
      vault: emptyVault(),
      fetcher,
      compute: {} as never,
      pathPolicy: new PathPolicy()
    })

    await expect(runner.run({
      job,
      signal: new AbortController().signal,
      updateProgress: async () => job
    })).rejects.toMatchObject({ code: 'TRANSLATION_CREDENTIALS_REQUIRED', retryable: false })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('marks the stored Copilotix token invalid after a definitive parser authentication error', async () => {
    const invalidateCredential = vi.fn(async () => undefined)
    const parserClient = {
      createUploadBatch: async () => { throw new ParserApiError('token invalid', 'A0202') }
    }
    const settingsService = {
      get: async () => appSettings({ state: 'valid' }),
      invalidateCredential
    }
    const runner = new ParseJobRunner({
      repository: { getTask: async () => ({ ...task, status: 'uploading' }) } as never,
      jobRepository: {} as never,
      settingsService: settingsService as never,
      vault: { get: async () => 'parser-token' } as never,
      parserClient: parserClient as never,
      compute: {} as never,
      pathPolicy: new PathPolicy()
    })

    const results = await runner.runBatch({
      jobs: [{ ...job, kind: 'parse' }],
      signal: new AbortController().signal,
      updateProgress: async () => job
    })
    expect(results[0]?.error).toMatchObject({ code: 'PARSER_SUBMIT_FAILED', retryable: false })
    expect(invalidateCredential).toHaveBeenCalledWith('parser', 'PARSER_TOKEN_INVALID', 'Parser API Token 无效，请重新验证')
  })
})

function appSettings(parser: AppSettings['credentials']['parser']): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    outputRoot: 'C:\\output',
    credentials: {
      parser,
      qwen: { state: 'missing' },
      deepseek: { state: 'missing' }
    }
  }
}

function emptyVault() {
  return {
    get: async () => null,
    set: async (_account: string, _value: string): Promise<void> => undefined,
    delete: async (_account: string): Promise<void> => undefined,
    has: async () => false
  }
}
