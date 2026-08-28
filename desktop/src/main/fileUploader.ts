import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { net } from 'electron'
import type { FileUploader } from './parserClient'

export class ElectronFileUploader implements FileUploader {
  async upload(
    filePath: string,
    uploadUrl: string,
    onProgress?: (sent: number, total: number) => void
  ): Promise<void> {
    const { size } = await stat(filePath)
    await new Promise<void>((resolve, reject) => {
      const request = net.request({ method: 'PUT', url: uploadUrl })
      const source = createReadStream(filePath)
      let sent = 0
      request.setHeader('Content-Length', String(size))
      request.on('response', (response) => {
        response.on('data', () => undefined)
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) resolve()
          else reject(new Error(`上传文件失败（HTTP ${response.statusCode}）`))
        })
        response.on('error', reject)
      })
      request.on('error', reject)
      source.on('error', (error) => {
        request.abort()
        reject(error)
      })
      source.on('data', (chunk) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        source.pause()
        sent += bytes.length
        onProgress?.(sent, size)
        request.write(bytes, undefined, () => source.resume())
      })
      source.on('end', () => request.end())
    })
  }
}
