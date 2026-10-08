import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { registerPaperInsightHandlers } from '../src/main/chat/paperInsightIpc'
import type { PaperInsightService } from '../src/main/chat/paperInsightService'
import type { IpcInvokeEventLike } from '../src/main/ipc'
import { decodeIpcEvent } from '../src/preload/ipcClient'
import { paperInsightChangedSchema } from '@shared/paperInsight'
import { ipcSuccess } from '@shared/ipc'

it('validates insight IDs, response and sender across all IPC methods and decodes event envelopes', async () => {
  const handlers = new Map<string, (event: IpcInvokeEventLike, payload: unknown) => Promise<unknown>>()
  const owner = { isDestroyed: () => false }, frame = { url: pathToFileURL(resolve('renderer/index.html')).href }
  const event = { sender: { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false, send: () => undefined }, senderFrame: frame }
  const get = vi.fn(async () => ({ status: 'missing' })), generate = vi.fn(async () => undefined), cancel = vi.fn(() => ({ cancelled: true }))
  registerPaperInsightHandlers({ get, generate, cancel } as unknown as PaperInsightService, {
    getMainWindow: () => owner, fromWebContents: () => owner, rendererEntryPath: resolve('renderer/index.html'),
    ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) } }
  })
  const request = { documentId: randomUUID() }
  for (const channel of ['paperInsight:get', 'paperInsight:generate', 'paperInsight:cancel']) {
    expect(await handlers.get(channel)!(event, { ...request, path: '/escape' })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    expect(await handlers.get(channel)!({ ...event, senderFrame: { url: frame.url } }, request)).toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
  }
  expect(get).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled()
  expect(await handlers.get('paperInsight:get')!(event, request)).toEqual(ipcSuccess({ status: 'missing' }))
  expect(await handlers.get('paperInsight:generate')!(event, request)).toEqual(ipcSuccess(undefined))
  expect(await handlers.get('paperInsight:cancel')!(event, request)).toEqual(ipcSuccess({ cancelled: true }))
  const changed = { ...request, state: { status: 'generating' } }
  expect(decodeIpcEvent(ipcSuccess(changed), paperInsightChangedSchema)).toEqual(changed)
  expect(decodeIpcEvent(changed, paperInsightChangedSchema)).toBeNull()
  expect(decodeIpcEvent(ipcSuccess({ ...changed, apiKey: 'secret' }), paperInsightChangedSchema)).toBeNull()
})
