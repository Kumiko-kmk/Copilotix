import { openAsBlob } from 'node:fs'
import { net } from 'electron'
import type { FileUploader } from './parserClient'

type NetFetcher = (input: string, init?: RequestInit) => Promise<Response>

export class ElectronFileUploader implements FileUploader {
  constructor(
    private readonly fetcher: NetFetcher = (input, init) => net.fetch(input, init),
    private readonly directFetcher: NetFetcher = (input, init) => fetch(input, init)
  ) {}

  async upload(
    filePath: string,
    uploadUrl: string,
    onProgress?: (sent: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const body = await openAsBlob(filePath)
    onProgress?.(0, body.size)
    const request: RequestInit = {
      method: 'PUT',
      body,
      credentials: 'omit',
      redirect: 'follow',
      signal: signal ?? AbortSignal.timeout(10 * 60 * 1000)
    }
    let response: Response
    try {
      response = await this.fetcher(uploadUrl, request)
    } catch (error) {
      if (signal?.aborted || !isElectronConnectionError(error)) throw error
      // Some signed object-storage PUTs are closed by Chromium's network stack.
      // A PUT of the same immutable file to the same signed URL is safe to retry.
      response = await this.directFetcher(uploadUrl, request)
    }
    if (response.body) {
      try {
        await response.body.cancel()
      } catch {
        // The upload result body is intentionally discarded.
      }
    }
    if (response.status !== 200) throw new Error(`上传文件失败（HTTP ${response.status}）`)
    onProgress?.(body.size, body.size)
  }
}

function isElectronConnectionError(error: unknown): boolean {
  return error instanceof Error && /net::ERR_CONNECTION_(?:CLOSED|RESET|TIMED_OUT)/u.test(error.message)
}
