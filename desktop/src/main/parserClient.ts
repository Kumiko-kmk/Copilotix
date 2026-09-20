import { createWriteStream } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { AppSettings, HealthResult, CopilotixTask } from '@shared/types'
import { PARSER_API_ORIGIN } from '@shared/constants'

export type OfficialTaskState = 'waiting-file' | 'pending' | 'running' | 'converting' | 'done' | 'failed'

export interface UploadTarget {
  taskId: string
  dataId: string
  uploadUrl: string
}

export interface BatchSubmission {
  batchId: string
  uploads: UploadTarget[]
}

export interface ExtractProgress {
  extractedPages: number
  totalPages: number
}

export interface BatchResultEntry {
  dataId: string | null
  fileName: string
  state: OfficialTaskState
  fullZipUrl: string | null
  error: string | null
  progress: ExtractProgress | null
}

export interface BatchResult {
  batchId: string
  entries: BatchResultEntry[]
}

export interface FileUploader {
  upload(filePath: string, uploadUrl: string, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal): Promise<void>
}

export interface ParserClient {
  verifyToken(token?: string | null): Promise<HealthResult>
  createUploadBatch(tasks: CopilotixTask[], settings: AppSettings, token?: string | null, signal?: AbortSignal): Promise<BatchSubmission>
  uploadFile(filePath: string, uploadUrl: string, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal): Promise<void>
  getBatchResult(batchId: string, token?: string | null, signal?: AbortSignal): Promise<BatchResult>
  waitForBatch(
    batchId: string,
    token: string,
    expectedDataIds: Set<string>,
    onUpdate: (result: BatchResult) => void,
    signal?: AbortSignal
  ): Promise<BatchResult>
  downloadResult(resultUrl: string, destinationPath: string, signal?: AbortSignal): Promise<void>
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface ApiEnvelope<T> {
  code: number | string
  msg: string
  trace_id?: string
  data?: T
}

interface UploadBatchData {
  batch_id: string
  file_urls: string[]
}

interface RawBatchResultData {
  batch_id: string
  extract_result: Array<{
    data_id?: string
    file_name?: string
    state?: string
    full_zip_url?: string
    err_msg?: string
    extract_progress?: {
      extracted_pages?: number
      total_pages?: number
    }
  }>
}

interface OfficialParserClientOptions {
  waitingFileTimeoutMs?: number
  pollIntervalMs?: number
  maxWaitMs?: number
}

const TOKEN_PROBE_BATCH_ID = '00000000-0000-0000-0000-000000000000'
const TERMINAL_STATES = new Set<OfficialTaskState>(['done', 'failed'])
const KNOWN_STATES = new Set<OfficialTaskState>([
  'waiting-file',
  'pending',
  'running',
  'converting',
  'done',
  'failed'
])

export class ParserApiError extends Error {
  constructor(
    message: string,
    readonly code: number | string,
    readonly traceId?: string
  ) {
    super(message)
    this.name = 'ParserApiError'
  }
}

export class OfficialParserClient implements ParserClient {
  private readonly waitingFileTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly maxWaitMs: number

  constructor(
    private readonly fetcher: Fetcher,
    private readonly uploader: FileUploader,
    options: OfficialParserClientOptions = {}
  ) {
    this.waitingFileTimeoutMs = options.waitingFileTimeoutMs ?? 2 * 60 * 1000
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000
    this.maxWaitMs = options.maxWaitMs ?? 6 * 60 * 60 * 1000
  }

  async verifyToken(token?: string | null): Promise<HealthResult> {
    if (!token?.trim()) return { ok: false, code: 'PARSER_TOKEN_MISSING', message: '请先输入 Parser API Token' }
    try {
      const response = await this.fetcher(
        `${PARSER_API_ORIGIN}/api/v4/extract-results/batch/${TOKEN_PROBE_BATCH_ID}`,
        { headers: authHeaders(token), signal: AbortSignal.timeout(15_000) }
      )
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return { ok: false, code: 'PARSER_TOKEN_INVALID', message: 'Parser API Token 无效' }
        }
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          return { ok: false, code: `HTTP_${response.status}`, message: 'Copilotix 验证服务暂不可用' }
        }
        return { ok: false, code: 'PARSER_TOKEN_INVALID', message: 'Parser API Token 验证失败' }
      }
      const payload = await readEnvelope<RawBatchResultData>(response)
      const code = String(payload.code)
      if (code === 'A0202') return resultFromEnvelope(false, payload, 'Token 错误')
      if (code === 'A0211') return resultFromEnvelope(false, payload, 'Token 已过期')
      if (payload.code === 0 || code === '-60012' || code === '-60013') {
        return resultFromEnvelope(true, payload, 'Token 验证成功')
      }
      return resultFromEnvelope(false, payload, payload.msg || 'Token 验证失败')
    } catch (_error) {
      return { ok: false, code: 'VALIDATION_UNAVAILABLE', message: '暂时无法连接 Copilotix 验证服务，请检查网络后重试' }
    }
  }

  async createUploadBatch(tasks: CopilotixTask[], _settings: AppSettings, token?: string | null, signal?: AbortSignal): Promise<BatchSubmission> {
    if (!token?.trim()) throw new Error('未配置 Parser API Token')
    if (tasks.length === 0) throw new Error('没有可提交的 PDF')
    const response = await this.fetcher(`${PARSER_API_ORIGIN}/api/v4/file-urls/batch`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        files: tasks.map((task) => ({ name: task.originalName || task.name, data_id: task.id })),
        model_version: 'vlm',
        enable_formula: true,
        enable_table: true
      }),
      signal: signal ?? AbortSignal.timeout(30_000)
    })
    const payload = await requireSuccess<UploadBatchData>(response, '申请文件上传链接失败')
    if (!payload.data || typeof payload.data.batch_id !== 'string' || !Array.isArray(payload.data.file_urls)) {
      throw new Error('Parser API 返回了无效的批次信息')
    }
    if (payload.data.file_urls.length !== tasks.length) throw new Error('Copilotix 返回的上传链接数量与文件数量不一致')

    return {
      batchId: payload.data.batch_id,
      uploads: tasks.map((task, index) => ({
        taskId: task.id,
        dataId: task.id,
        uploadUrl: requireHttpsUrl(payload.data!.file_urls[index]!, '上传链接')
      }))
    }
  }

  uploadFile(
    filePath: string,
    uploadUrl: string,
    onProgress?: (sent: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const target = requireHttpsUrl(uploadUrl, '上传链接')
    return signal === undefined
      ? this.uploader.upload(filePath, target, onProgress)
      : this.uploader.upload(filePath, target, onProgress, signal)
  }

  async getBatchResult(batchId: string, token?: string | null, signal?: AbortSignal): Promise<BatchResult> {
    if (!token?.trim()) throw new Error('未配置 Parser API Token')
    const response = await this.fetcher(
      `${PARSER_API_ORIGIN}/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`,
      { headers: authHeaders(token), signal: signal ?? AbortSignal.timeout(30_000) }
    )
    const payload = await requireSuccess<RawBatchResultData>(response, '查询 Copilotix 批次结果失败')
    if (!payload.data || !Array.isArray(payload.data.extract_result)) throw new Error('Parser API 返回了无效的批次结果')
    return {
      batchId: payload.data.batch_id || batchId,
      entries: payload.data.extract_result.map((entry) => {
        const state = normalizeState(entry.state)
        const extractedPages = entry.extract_progress?.extracted_pages
        const totalPages = entry.extract_progress?.total_pages
        return {
          dataId: typeof entry.data_id === 'string' ? entry.data_id : null,
          fileName: typeof entry.file_name === 'string' ? entry.file_name : '',
          state,
          fullZipUrl:
            state === 'done' && typeof entry.full_zip_url === 'string'
              ? requireHttpsUrl(entry.full_zip_url, '结果下载链接')
              : null,
          error: state === 'failed' ? entry.err_msg || 'Copilotix 解析失败' : null,
          progress:
            typeof extractedPages === 'number' && typeof totalPages === 'number' && totalPages > 0
              ? { extractedPages, totalPages }
              : null
        }
      })
    }
  }

  async waitForBatch(
    batchId: string,
    token: string,
    expectedDataIds: Set<string>,
    onUpdate: (result: BatchResult) => void,
    signal?: AbortSignal
  ): Promise<BatchResult> {
    const startedAt = Date.now()
    const deadline = startedAt + this.maxWaitMs
    let delayMs = this.pollIntervalMs
    while (Date.now() < deadline) {
      const result = expireUnregisteredUploads(
        await this.getBatchResult(batchId, token, signal),
        expectedDataIds,
        Date.now() - startedAt >= this.waitingFileTimeoutMs
      )
      onUpdate(result)
      const entriesByDataId = new Map(result.entries.map((entry) => [entry.dataId, entry]))
      if (
        expectedDataIds.size > 0 &&
        [...expectedDataIds].every((dataId) => {
          const entry = entriesByDataId.get(dataId)
          return Boolean(entry && TERMINAL_STATES.has(entry.state))
        })
      ) return result
      await delay(delayMs, signal)
      delayMs = Math.min(10_000, Math.max(this.pollIntervalMs, Math.round(delayMs * 1.15)))
    }
    throw new Error('等待 Copilotix 解析结果超时')
  }

  async downloadResult(resultUrl: string, destinationPath: string, signal?: AbortSignal): Promise<void> {
    let completed = false
    try {
      const response = await this.fetcher(requireHttpsUrl(resultUrl, '结果下载链接'), {
        signal: signal ?? AbortSignal.timeout(10 * 60 * 1000)
      })
      if (!response.ok) throw new Error(`下载解析结果失败（HTTP ${response.status}）`)
      const contentLengthHeader = response.headers.get('content-length')
      if (contentLengthHeader !== null) {
        const contentLength = Number(contentLengthHeader)
        if (!Number.isSafeInteger(contentLength) || contentLength < 4 || contentLength > MAX_RESULT_ZIP_BYTES) {
          throw new Error('Copilotix 解析结果超过支持的 ZIP 大小限制')
        }
      }
      if (!response.body) throw new Error('Copilotix 解析结果缺少响应内容')

      let size = 0
      let header = Buffer.alloc(0)
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += buffer.length
          if (size > MAX_RESULT_ZIP_BYTES) {
            callback(new Error('Copilotix 解析结果超过支持的 ZIP 大小限制'))
            return
          }
          if (header.length < 4) header = Buffer.concat([header, buffer]).subarray(0, 4)
          callback(null, buffer)
        }
      })
      await pipeline(
        Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>),
        limiter,
        createWriteStream(destinationPath, { flags: 'wx' }),
        { signal }
      )
      if (header.length < 4 || header[0] !== 0x50 || header[1] !== 0x4b) throw new Error('Copilotix 解析结果不是有效的 ZIP 文件')
      const handle = await open(destinationPath, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      completed = true
    } finally {
      if (!completed) await rm(destinationPath, { force: true }).catch(() => undefined)
    }
  }
}

export const MAX_RESULT_ZIP_BYTES = 512 * 1024 * 1024

function expireUnregisteredUploads(result: BatchResult, expectedDataIds: Set<string>, expired: boolean): BatchResult {
  if (!expired) return result
  const entries = result.entries.map((entry) =>
    entry.dataId && expectedDataIds.has(entry.dataId) && entry.state === 'waiting-file'
      ? { ...entry, state: 'failed' as const, error: 'Copilotix 未检测到已上传文件，请重试任务。' }
      : entry
  )
  const present = new Set(entries.map((entry) => entry.dataId).filter((dataId): dataId is string => Boolean(dataId)))
  for (const dataId of expectedDataIds) {
    if (present.has(dataId)) continue
    entries.push({
      dataId,
      fileName: '',
      state: 'failed',
      fullZipUrl: null,
      error: 'Copilotix 批次结果未返回对应 data_id，请重试任务。',
      progress: null
    })
  }
  return { ...result, entries }
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token.trim()}` }
}

async function requireSuccess<T>(response: Response, prefix: string): Promise<ApiEnvelope<T>> {
  const payload = await readEnvelope<T>(response)
  if (!response.ok || payload.code !== 0) {
    const trace = payload.trace_id ? `，trace_id=${payload.trace_id}` : ''
    const code = !response.ok ? `HTTP_${response.status}` : payload.code
    // Keep remote response text out of the Error.  The service can echo
    // request data in `msg`; callers persist/log this error and must never
    // accidentally expose the bearer token.
    const reason = !response.ok ? `HTTP ${response.status}` : 'Parser API 返回业务错误'
    throw new ParserApiError(
      `${prefix}：${reason}（code=${String(code)}${trace}）`,
      code,
      payload.trace_id
    )
  }
  return payload
}

async function readEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ParserApiError(`Parser API 返回非 JSON 响应（HTTP ${response.status}）`, `HTTP_${response.status}`)
  }
  if (!payload || typeof payload !== 'object' || !('code' in payload)) {
    throw new Error('Parser API 返回了无效响应')
  }
  const envelope = payload as ApiEnvelope<T>
  return { ...envelope, msg: typeof envelope.msg === 'string' ? envelope.msg : '' }
}

function resultFromEnvelope(ok: boolean, payload: ApiEnvelope<unknown>, message: string, validationCode?: string): HealthResult {
  return { ok, message, code: validationCode ?? payload.code, traceId: payload.trace_id }
}

function normalizeState(value: unknown): OfficialTaskState {
  if (typeof value === 'string' && KNOWN_STATES.has(value as OfficialTaskState)) return value as OfficialTaskState
  throw new Error(`Copilotix 返回未知任务状态：${String(value)}`)
}

function requireHttpsUrl(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label}无效`)
  }
  if (url.protocol !== 'https:') throw new Error(`${label}必须使用 HTTPS`)
  return url.toString()
}


function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('请求已取消'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('请求已取消'))
    }, { once: true })
  })
}
