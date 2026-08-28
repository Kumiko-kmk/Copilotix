import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import { ElectronFileUploader } from '@main/fileUploader'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('ElectronFileUploader', () => {
  it('uploads a file-backed Blob without authorization or content type headers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mineru-uploader-'))
    temporaryRoots.push(root)
    const filePath = join(root, 'fixture.pdf')
    await writeFile(filePath, '%PDF fixture')
    const fetcher = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 200 })
    )
    const progress = vi.fn()

    await new ElectronFileUploader(fetcher).upload(filePath, 'https://upload.example/signed?secret=value', progress)

    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://upload.example/signed?secret=value')
    expect(init).toMatchObject({ method: 'PUT', credentials: 'omit', redirect: 'follow' })
    expect(init?.headers).toBeUndefined()
    expect(init?.body).toBeInstanceOf(Blob)
    expect((init?.body as Blob).type).toBe('')
    expect((init?.body as Blob).size).toBe(12)
    expect(progress).toHaveBeenLastCalledWith(12, 12)
  })

  it('requires the documented HTTP 200 upload response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mineru-uploader-'))
    temporaryRoots.push(root)
    const filePath = join(root, 'fixture.pdf')
    await writeFile(filePath, '%PDF fixture')
    const uploader = new ElectronFileUploader(async () => new Response(null, { status: 204 }))

    await expect(uploader.upload(filePath, 'https://upload.example/signed')).rejects.toThrow('HTTP 204')
  })
})
