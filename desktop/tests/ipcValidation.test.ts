import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertTrustedSender, isTrustedRendererUrl, registerValidatedHandler, toIpcError, type IpcInvokeEventLike, type IpcMainLike } from '../src/main/ipc'
import { z } from 'zod'

function makeEvent(url: string): IpcInvokeEventLike {
  const frame = { url }
  const sender = {
    mainFrame: frame,
    getURL: () => url,
    isDestroyed: () => false,
    send: () => undefined
  }
  return { sender, senderFrame: frame }
}

function makeOptions(url: string) {
  const owner = { isDestroyed: () => false }
  return {
    getMainWindow: () => owner,
    fromWebContents: () => owner,
    rendererEntryPath: resolve('renderer/index.html'),
    rendererOrigin: url.startsWith('http') ? url : undefined
  }
}

describe('validated IPC handler', () => {
  it('accepts only the owner window main frame and trusted URL', () => {
    const entryPath = resolve('renderer/index.html')
    const entryUrl = pathToFileURL(entryPath).href
    const options = makeOptions(entryUrl)
    expect(isTrustedRendererUrl(entryUrl, options)).toBe(true)
    expect(isTrustedRendererUrl(`${entryUrl}?query=1`, options)).toBe(false)
    expect(() => assertTrustedSender(makeEvent(entryUrl), options)).not.toThrow()
    expect(() => assertTrustedSender(makeEvent('file:///untrusted/index.html'), options)).toThrow(/来源无效/)
  })

  it('wraps successful results and validation failures in one response envelope', async () => {
    let listener: ((event: IpcInvokeEventLike, request: unknown) => Promise<unknown>) | undefined
    const fakeIpcMain: IpcMainLike = { handle: (_channel, handler) => { listener = handler } }
    const entryUrl = pathToFileURL(resolve('renderer/index.html')).href
    const options = { ...makeOptions(entryUrl), ipcMain: fakeIpcMain }
    const requestSchema = z.object({ value: z.string().min(1) }).strict()
    const responseSchema = z.object({ length: z.number().int() }).strict()
    registerValidatedHandler(
      'test:ipc',
      requestSchema,
      responseSchema,
      (_event, request) => ({ length: request.value.length }),
      options
    )
    expect(listener).toBeDefined()
    const event = makeEvent(entryUrl)
    await expect(listener?.(event, { value: 'ok' })).resolves.toEqual({ ok: true, value: { length: 2 } })
    await expect(listener?.(event, { value: '' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })

  it('does not leak a handler exception as a rejected renderer invoke', async () => {
    let listener: ((event: IpcInvokeEventLike, request: unknown) => Promise<unknown>) | undefined
    const fakeIpcMain: IpcMainLike = { handle: (_channel, handler) => { listener = handler } }
    const entryUrl = pathToFileURL(resolve('renderer/index.html')).href
    registerValidatedHandler(
      'test:error',
      z.undefined(),
      z.string(),
      () => { throw new Error('expected failure') },
      { ...makeOptions(entryUrl), ipcMain: fakeIpcMain }
    )
    await expect(listener?.(makeEvent(entryUrl), undefined)).resolves.toMatchObject({
      ok: false,
      error: { code: 'HANDLER_ERROR', message: 'expected failure' }
    })
    await expect(listener?.(makeEvent(entryUrl.replace('renderer/index.html', 'other.html')), undefined)).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNTRUSTED_SENDER' }
    })
  })

  it('preserves stable domain error codes and marks annotation conflicts non-retryable', () => {
    const error = Object.assign(new Error('标注版本已变化'), { code: 'ANNOTATION_CONFLICT' })
    expect(toIpcError(error, 'HANDLER_ERROR')).toMatchObject({ code: 'ANNOTATION_CONFLICT', retryable: false })
  })
})
