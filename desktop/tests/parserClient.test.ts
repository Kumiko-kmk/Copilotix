import { describe, expect, it, vi } from 'vitest'
import { OfficialMinerUClient, type FileUploader } from '@main/parserClient'
import type { AppSettings, MinerUTask } from '@shared/types'

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const settings: AppSettings = {
  hasParserToken: true,
  outputRoot: 'C:\\output',
  parserModel: 'vlm',
  forceOcr: true,
  formulaEnabled: true,
  tableEnabled: false,
  ocrLanguage: 'en',
  translationProvider: 'qwen',
  qwenBaseUrl: 'https://example.test/v1',
  qwenModel: 'qwen-mt-plus',
  qwenHasApiKey: false,
  deepseekBaseUrl: 'https://example.test/v1',
  deepseekModel: 'deepseek-chat',
  deepseekHasApiKey: false
}

const task: MinerUTask = {
  id: 'task-1',
  originalName: 'paper.pdf',
  title: null,
  name: 'Attention Is All You Need.pdf',
  sourcePath: 'C:\\paper.pdf',
  sourceHash: 'hash',
  outputDir: 'C:\\output\\paper',
  status: 'uploading',
  progress: 0,
  parserModel: 'vlm',
  translationProvider: 'qwen',
  remoteBatchId: null,
  remoteDataId: null,
  remoteResultUrl: null,
  error: null,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z'
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('OfficialMinerUClient', () => {
  it('requests official upload URLs with documented JSON fields', async () => {
    const fetcher = vi.fn<Fetcher>(async () => jsonResponse({
      code: 0,
      msg: 'ok',
      data: { batch_id: 'batch-1', file_urls: ['https://upload.example.test/signed?secret=value'] }
    }))
    const uploader: FileUploader = { upload: vi.fn(async () => undefined) }
    const client = new OfficialMinerUClient(fetcher, uploader)

    const submission = await client.createUploadBatch([task], settings, 'token-value')

    expect(submission).toEqual({
      batchId: 'batch-1',
      uploads: [{ taskId: 'task-1', dataId: 'task-1', uploadUrl: 'https://upload.example.test/signed?secret=value' }]
    })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://mineru.net/api/v4/file-urls/batch')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer token-value', 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init?.body))).toEqual({
      files: [{ name: 'paper.pdf', data_id: 'task-1', is_ocr: true }],
      model_version: 'vlm',
      enable_formula: true,
      enable_table: false,
      language: 'en'
    })
  })

  it('delegates the raw upload without exposing credentials to the uploader', async () => {
    const upload = vi.fn(async () => undefined)
    const client = new OfficialMinerUClient(vi.fn(), { upload })
    await client.uploadFile('C:\\paper.pdf', 'https://upload.example.test/signed')
    expect(upload).toHaveBeenCalledWith('C:\\paper.pdf', 'https://upload.example.test/signed', undefined)
  })

  it('maps documented batch states and progress', async () => {
    const client = new OfficialMinerUClient(
      vi.fn(async () => jsonResponse({
        code: 0,
        msg: 'ok',
        data: {
          batch_id: 'batch-1',
          extract_result: [{
            data_id: 'task-1',
            file_name: 'paper.pdf',
            state: 'running',
            err_msg: '',
            extract_progress: { extracted_pages: 3, total_pages: 10 }
          }]
        }
      })),
      { upload: vi.fn() }
    )
    await expect(client.getBatchResult('batch-1', 'token')).resolves.toEqual({
      batchId: 'batch-1',
      entries: [{
        dataId: 'task-1',
        fileName: 'paper.pdf',
        state: 'running',
        fullZipUrl: null,
        error: null,
        progress: { extractedPages: 3, totalPages: 10 }
      }]
    })
  })

  it('treats task-not-found as a successful non-mutating token probe', async () => {
    const client = new OfficialMinerUClient(
      vi.fn(async () => jsonResponse({ code: -60012, msg: '找不到任务', trace_id: 'trace-1' })),
      { upload: vi.fn() }
    )
    await expect(client.verifyToken('token')).resolves.toEqual({
      ok: true,
      message: 'Token 验证成功',
      code: -60012,
      traceId: 'trace-1'
    })
  })

  it.each([
    ['A0202', 'Token 错误'],
    ['A0211', 'Token 已过期']
  ])('reports official token error %s', async (code, message) => {
    const client = new OfficialMinerUClient(
      vi.fn(async () => jsonResponse({ code, msg: message, trace_id: 'token-trace' })),
      { upload: vi.fn() }
    )
    await expect(client.verifyToken('invalid-token')).resolves.toEqual({
      ok: false,
      message,
      code,
      traceId: 'token-trace'
    })
  })

  it('rejects non-zero API codes even when HTTP is 200', async () => {
    const client = new OfficialMinerUClient(
      vi.fn(async () => jsonResponse({ code: -60005, msg: '文件大小超出限制', trace_id: 'trace-2' })),
      { upload: vi.fn() }
    )
    await expect(client.createUploadBatch([task], settings, 'token')).rejects.toThrow(/-60005.*trace_id=trace-2/)
  })

  it('accepts a ZIP response from the result CDN without Authorization', async () => {
    const fetcher = vi.fn<Fetcher>(async () => new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04])))
    const client = new OfficialMinerUClient(fetcher, { upload: vi.fn() })
    await expect(client.downloadResult('https://cdn.example.test/result.zip')).resolves.toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
    expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined()
  })

  it('turns an unregistered waiting-file upload into a recoverable file failure', async () => {
    const fetcher = vi.fn<Fetcher>(async () => jsonResponse({
      code: 0,
      msg: 'ok',
      data: {
        batch_id: 'batch-stuck',
        extract_result: [{ data_id: 'task-1', file_name: 'paper.pdf', state: 'waiting-file' }]
      }
    }))
    const client = new OfficialMinerUClient(fetcher, { upload: vi.fn() }, {
      waitingFileTimeoutMs: 0,
      pollIntervalMs: 1,
      maxWaitMs: 100
    })
    const updates: Array<{ state: string; error: string | null }> = []

    const result = await client.waitForBatch('batch-stuck', 'token', new Set(['task-1']), (batch) => {
      updates.push({ state: batch.entries[0]!.state, error: batch.entries[0]!.error })
    })

    expect(result.entries[0]).toMatchObject({
      dataId: 'task-1',
      state: 'failed',
      error: 'MinerU 未检测到已上传文件，请重试任务。'
    })
    expect(updates).toEqual([{ state: 'failed', error: 'MinerU 未检测到已上传文件，请重试任务。' }])
  })
})
