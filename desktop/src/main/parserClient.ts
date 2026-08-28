import type { AppSettings, HealthResult, MinerUTask } from '@shared/types'
import { MINERU_API_ORIGIN } from '@shared/constants'

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
  upload(filePath: string, uploadUrl: string, onProgress?: (sent: number, total: number) => void): Promise<void>
}

export interface MinerUClient {
  verifyToken(token?: string | null): Promise<HealthResult>
  createUploadBatch(tasks: MinerUTask[], settings: AppSettings, token?: string | null): Promise<BatchSubmission>
  uploadFile(filePath: string, uploadUrl: string, onProgress?: (sent: number, total: number) => void): Promise<void>
  getBatchResult(batchId: string, token?: string | null): Promise<BatchResult>
  waitForBatch(
    batchId: string,
    token: string,
    expectedDataIds: Set<string>,
    onUpdate: (result: BatchResult) => void
  ): Promise<BatchResult>
  downloadResult(resultUrl: string): Promise<Uint8Array>
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

export class MinerUApiError extends Error {
  constructor(
    message: string,
    readonly code: number | string,
    readonly traceId?: string
  ) {
    super(message)
    this.name = 'MinerUApiError'
  }
}

export class OfficialMinerUClient implements MinerUClient {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly uploader: FileUploader
  ) {}

  async verifyToken(token?: string | null): Promise<HealthResult> {
    if (!token?.trim()) return { ok: false, message: '请先输入 MinerU API Token' }
    try {
      const response = await this.fetcher(
        `${MINERU_API_ORIGIN}/api/v4/extract-results/batch/${TOKEN_PROBE_BATCH_ID}`,
        { headers: authHeaders(token), signal: AbortSignal.timeout(15_000) }
      )
      const payload = await readEnvelope<RawBatchResultData>(response)
      const code = String(payload.code)
      if (code === 'A0202') return resultFromEnvelope(false, payload, 'Token 错误')
      if (code === 'A0211') return resultFromEnvelope(false, payload, 'Token 已过期')
      if (payload.code === 0 || code === '-60012' || code === '-60013') {
        return resultFromEnvelope(true, payload, 'Token 验证成功')
      }
      return resultFromEnvelope(false, payload, payload.msg || 'Token 验证失败')
    } catch (error) {
      return { ok: false, message: readableError(error) }
    }
  }

  async createUploadBatch(tasks: MinerUTask[], settings: AppSettings, token?: string | null): Promise<BatchSubmission> {
    if (!token?.trim()) throw new Error('未配置 MinerU API Token')
    if (tasks.length === 0) throw new Error('没有可提交的 PDF')
    const parserModel = tasks[0]?.parserModel
    if (tasks.some((task) => task.parserModel !== parserModel)) throw new Error('同一批次必须使用相同解析模型')

    const response = await this.fetcher(`${MINERU_API_ORIGIN}/api/v4/file-urls/batch`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        files: tasks.map((task) => ({ name: task.name, data_id: task.id, is_ocr: settings.forceOcr })),
        model_version: parserModel,
        enable_formula: settings.formulaEnabled,
        enable_table: settings.tableEnabled,
        language: settings.ocrLanguage
      }),
      signal: AbortSignal.timeout(30_000)
    })
    const payload = await requireSuccess<UploadBatchData>(response, '申请文件上传链接失败')
    if (!payload.data || typeof payload.data.batch_id !== 'string' || !Array.isArray(payload.data.file_urls)) {
      throw new Error('MinerU API 返回了无效的批次信息')
    }
    if (payload.data.file_urls.length !== tasks.length) throw new Error('MinerU 返回的上传链接数量与文件数量不一致')

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
    onProgress?: (sent: number, total: number) => void
  ): Promise<void> {
    return this.uploader.upload(filePath, requireHttpsUrl(uploadUrl, '上传链接'), onProgress)
  }

  async getBatchResult(batchId: string, token?: string | null): Promise<BatchResult> {
    if (!token?.trim()) throw new Error('未配置 MinerU API Token')
    const response = await this.fetcher(
      `${MINERU_API_ORIGIN}/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`,
      { headers: authHeaders(token), signal: AbortSignal.timeout(30_000) }
    )
    const payload = await requireSuccess<RawBatchResultData>(response, '查询 MinerU 批次结果失败')
    if (!payload.data || !Array.isArray(payload.data.extract_result)) throw new Error('MinerU API 返回了无效的批次结果')
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
          error: state === 'failed' ? entry.err_msg || 'MinerU 解析失败' : null,
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
    onUpdate: (result: BatchResult) => void
  ): Promise<BatchResult> {
    const deadline = Date.now() + 6 * 60 * 60 * 1000
    let delayMs = 2_000
    while (Date.now() < deadline) {
      const result = await this.getBatchResult(batchId, token)
      onUpdate(result)
      const entriesByDataId = new Map(result.entries.map((entry) => [entry.dataId, entry]))
      if (
        expectedDataIds.size > 0 &&
        [...expectedDataIds].every((dataId) => {
          const entry = entriesByDataId.get(dataId)
          return Boolean(entry && TERMINAL_STATES.has(entry.state))
        })
      ) return result
      await delay(delayMs)
      delayMs = Math.min(10_000, Math.round(delayMs * 1.15))
    }
    throw new Error('等待 MinerU 解析结果超时')
  }

  async downloadResult(resultUrl: string): Promise<Uint8Array> {
    const response = await this.fetcher(requireHttpsUrl(resultUrl, '结果下载链接'), {
      signal: AbortSignal.timeout(10 * 60 * 1000)
    })
    if (!response.ok) throw new Error(`下载解析结果失败（HTTP ${response.status}）`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('MinerU 解析结果不是有效的 ZIP 文件')
    return bytes
  }
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token.trim()}` }
}

async function requireSuccess<T>(response: Response, prefix: string): Promise<ApiEnvelope<T>> {
  const payload = await readEnvelope<T>(response)
  if (!response.ok || payload.code !== 0) {
    const trace = payload.trace_id ? `，trace_id=${payload.trace_id}` : ''
    throw new MinerUApiError(
      `${prefix}：${payload.msg || `HTTP ${response.status}`}（code=${String(payload.code)}${trace}）`,
      payload.code,
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
    throw new Error(`MinerU API 返回非 JSON 响应（HTTP ${response.status}）`)
  }
  if (!payload || typeof payload !== 'object' || !('code' in payload)) {
    throw new Error('MinerU API 返回了无效响应')
  }
  const envelope = payload as ApiEnvelope<T>
  return { ...envelope, msg: typeof envelope.msg === 'string' ? envelope.msg : '' }
}

function resultFromEnvelope(ok: boolean, payload: ApiEnvelope<unknown>, message: string): HealthResult {
  return { ok, message, code: payload.code, traceId: payload.trace_id }
}

function normalizeState(value: unknown): OfficialTaskState {
  if (typeof value === 'string' && KNOWN_STATES.has(value as OfficialTaskState)) return value as OfficialTaskState
  throw new Error(`MinerU 返回未知任务状态：${String(value)}`)
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

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
