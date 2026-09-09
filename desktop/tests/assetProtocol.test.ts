import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAssetResponse, parseRange } from '@main/assetProtocol'

describe('copilotix-asset protocol response', () => {
  let root = ''
  let pdfPath = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copilotix-asset-test-'))
    pdfPath = join(root, 'original.pdf')
    await writeFile(pdfPath, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('returns a complete PDF with CORS and range headers', async () => {
    const response = await createAssetResponse(new Request('copilotix-asset://task/original.pdf'), () => pdfPath)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]))
  })

  it('supports HEAD and a single byte range', async () => {
    const head = await createAssetResponse(new Request('copilotix-asset://task/original.pdf', { method: 'HEAD' }), () => pdfPath)
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('8')
    expect(await head.text()).toBe('')

    const partial = await createAssetResponse(
      new Request('copilotix-asset://task/original.pdf', { headers: { Range: 'bytes=1-3' } }),
      () => pdfPath
    )
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 1-3/8')
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(new Uint8Array([0x50, 0x44, 0x46]))
  })

  it('returns 416 for an invalid range and 404 for an invalid path', async () => {
    const invalidRange = await createAssetResponse(
      new Request('copilotix-asset://task/original.pdf', { headers: { Range: 'bytes=99-100' } }),
      () => pdfPath
    )
    expect(invalidRange.status).toBe(416)
    expect(invalidRange.headers.get('content-range')).toBe('bytes */8')

    const missing = await createAssetResponse(
      new Request('copilotix-asset://task/../secret.pdf'),
      () => { throw new Error('非法资源路径') }
    )
    expect(missing.status).toBe(404)
  })

  it('parses open and suffix ranges', () => {
    expect(parseRange('bytes=2-', 8)).toEqual({ start: 2, end: 7 })
    expect(parseRange('bytes=-3', 8)).toEqual({ start: 5, end: 7 })
    expect(parseRange('bytes=1-2,4-5', 8)).toBeNull()
  })
})
