import { openAsBlob } from 'node:fs'
import { net } from 'electron'
import type { FileUploader } from './parserClient'

type NetFetcher = (input: string, init?: RequestInit) => Promise<Response>

export class ElectronFileUploader implements FileUploader {
  constructor(
    private readonly fetcher: NetFetcher = (input, init) => net.fetch(input, init)
  ) {}

  async upload(
    filePath: string,
    uploadUrl: string,
    onProgress?: (sent: number, total: number) => void
  ): Promise<void> {
    const body = await openAsBlob(filePath)
    onProgress?.(0, body.size)
    const response = await this.fetcher(uploadUrl, {
      method: 'PUT',
      body,
      credentials: 'omit',
      redirect: 'follow',
      signal: AbortSignal.timeout(10 * 60 * 1000)
    })
    await response.arrayBuffer()
    if (response.status !== 200) throw new Error(`上传文件失败（HTTP ${response.status}）`)
    onProgress?.(body.size, body.size)
  }
}
