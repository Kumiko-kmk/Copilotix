import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { AppSettings, HealthResult, MinerUTask } from '@shared/types'
import { API_PROTOCOL_VERSION } from '@shared/constants'

export interface ParseSubmission {
  taskId: string
  statusUrl: string
  resultUrl: string
}

export interface ParserClient {
  health(baseUrl: string, token?: string | null): Promise<HealthResult>
  submit(task: MinerUTask, settings: AppSettings, token?: string | null): Promise<ParseSubmission>
  waitForCompletion(submission: ParseSubmission, token?: string | null): Promise<void>
  downloadResult(resultUrl: string, token?: string | null): Promise<Uint8Array>
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class MinerUApiV2Client implements ParserClient {
  constructor(private readonly fetcher: Fetcher) {}

  async health(baseUrl: string, token?: string | null): Promise<HealthResult> {
    try {
      const url = `${normalizeBaseUrl(baseUrl)}/health`
      const response = await this.fetcher(url, { headers: authHeaders(token), signal: AbortSignal.timeout(15_000) })
      if (!response.ok) return { ok: false, message: `服务返回 HTTP ${response.status}` }
      const payload = (await response.json()) as Record<string, unknown>
      if (payload.status !== 'healthy') return { ok: false, message: 'MinerU 服务当前不健康' }
      if (String(payload.protocol_version) !== API_PROTOCOL_VERSION) {
        return {
          ok: false,
          message: `协议版本不兼容：服务为 ${String(payload.protocol_version)}，客户端需要 ${API_PROTOCOL_VERSION}`
        }
      }
      return {
        ok: true,
        message: '连接成功',
        protocolVersion: String(payload.protocol_version),
        maxConcurrentRequests:
          typeof payload.max_concurrent_requests === 'number' ? payload.max_concurrent_requests : undefined
      }
    } catch (error) {
      return { ok: false, message: readableError(error) }
    }
  }

  async submit(task: MinerUTask, settings: AppSettings, token?: string | null): Promise<ParseSubmission> {
    const bytes = await readFile(task.sourcePath)
    const form = new FormData()
    form.append('files', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), basename(task.sourcePath))
    form.append('lang_list', settings.ocrLanguage)
    form.append('backend', task.parserModel)
    form.append('effort', settings.parserEffort)
    form.append('parse_method', settings.forceOcr ? 'ocr' : 'auto')
    form.append('formula_enable', String(settings.formulaEnabled))
    form.append('table_enable', String(settings.tableEnabled))
    form.append('image_analysis', String(settings.parserEffort === 'high'))
    form.append('return_md', 'true')
    form.append('return_middle_json', 'true')
    form.append('return_model_output', 'false')
    form.append('return_content_list', 'true')
    form.append('return_images', 'true')
    form.append('response_format_zip', 'true')
    form.append('return_original_file', 'false')
    form.append('client_side_output_generation', 'false')
    form.append('start_page_id', '0')
    form.append('end_page_id', '99999')

    const response = await this.fetcher(`${normalizeBaseUrl(settings.parserBaseUrl)}/tasks`, {
      method: 'POST',
      headers: authHeaders(token),
      body: form,
      signal: AbortSignal.timeout(120_000)
    })
    if (response.status !== 202) throw new Error(await responseMessage(response, '提交解析任务失败'))
    const payload = (await response.json()) as Record<string, unknown>
    if (
      typeof payload.task_id !== 'string' ||
      typeof payload.status_url !== 'string' ||
      typeof payload.result_url !== 'string'
    ) {
      throw new Error('MinerU API 返回了无效的任务信息')
    }
    return {
      taskId: payload.task_id,
      statusUrl: resolveServerUrl(settings.parserBaseUrl, payload.status_url),
      resultUrl: resolveServerUrl(settings.parserBaseUrl, payload.result_url)
    }
  }

  async waitForCompletion(submission: ParseSubmission, token?: string | null): Promise<void> {
    const deadline = Date.now() + 6 * 60 * 60 * 1000
    while (Date.now() < deadline) {
      const response = await this.fetcher(submission.statusUrl, {
        headers: authHeaders(token),
        signal: AbortSignal.timeout(30_000)
      })
      if (!response.ok) throw new Error(await responseMessage(response, '查询解析状态失败'))
      const payload = (await response.json()) as Record<string, unknown>
      if (payload.status === 'completed') return
      if (payload.status !== 'pending' && payload.status !== 'processing') {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'MinerU 解析任务失败')
      }
      await delay(2_000)
    }
    throw new Error('等待 MinerU 解析结果超时')
  }

  async downloadResult(resultUrl: string, token?: string | null): Promise<Uint8Array> {
    const response = await this.fetcher(resultUrl, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(10 * 60 * 1000)
    })
    if (!response.ok) throw new Error(await responseMessage(response, '下载解析结果失败'))
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('application/zip')) throw new Error(`解析结果不是 ZIP：${contentType || '未知类型'}`)
    return new Uint8Array(await response.arrayBuffer())
  }
}

export function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '')
  const url = new URL(normalized)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('服务地址必须使用 HTTP 或 HTTPS')
  return normalized
}

export function isInsecurePublicUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:') return false
    return !['localhost', '127.0.0.1', '::1'].includes(url.hostname) && !isPrivateIpv4(url.hostname)
  } catch {
    return false
  }
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false
  return parts[0] === 10 || (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) || (parts[0] === 192 && parts[1] === 168)
}

function authHeaders(token?: string | null): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function resolveServerUrl(baseUrl: string, value: string): string {
  return new URL(value, `${normalizeBaseUrl(baseUrl)}/`).toString()
}

async function responseMessage(response: Response, prefix: string): Promise<string> {
  const text = await response.text()
  return `${prefix}（HTTP ${response.status}）${text ? `：${text.slice(0, 500)}` : ''}`
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
