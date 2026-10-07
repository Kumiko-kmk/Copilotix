import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { paperChatAskRequestSchema, paperContextRequestSchema, paperContextResultSchema } from '@shared/paperChatSchemas'
import { appSettingsSchema, settingsUpdateSchema } from '@shared/ipcSchemas'
import { coreRequestSchema, validateCoreOperationResult, serializeCoreMessage, makeCoreEvent } from '@shared/coreRpcSchemas'
import { CoreClient } from '@core/coreClient'
import { registerPaperChatHandlers } from '../src/main/chat/paperChatIpc'
import { PaperChatService } from '../src/main/chat/paperChatService'
import type { IpcInvokeEventLike } from '../src/main/ipc'

const doc = '10000000-0000-4000-8000-000000000001'
const request = { documentId: doc, question: 'question', pinned: [], history: [] }
const pin = { view: 'original', text: 'text', contentRevisionId: 'revision1', fragments: [{ mappingIds: ['m1'], quote: 'text', startOffset: 0, endOffset: 4 }] }

describe('paper chat wire contracts', () => {
  it('bounds questions, pins, history, provider choices and model names', () => {
    expect(paperChatAskRequestSchema.parse(request)).toEqual(request)
    for (const invalid of [{ question: '' }, { question: ' ' }, { question: 'a'.repeat(2001) }, { pinned: Array(9).fill(pin) }, { history: Array(13).fill({ role: 'user', content: 'x' }) }, { history: Array(4).fill({ role: 'user', content: 'x'.repeat(8192) }) }, { pinned: [{ ...pin, fragments: [{ ...pin.fragments[0], endOffset: 0 }] }] }, { baseUrl: 'https://attacker.test' }, { documentId: 'path/to/paper' }, { model: '' }, { model: 'bad\nmodel' }, { model: 'a'.repeat(129) }, { provider: 'bing' }]) {
      expect(() => paperChatAskRequestSchema.parse({ ...request, ...invalid })).toThrow()
    }
    const { credentials: _credentials, ...update } = DEFAULT_SETTINGS
    expect(() => settingsUpdateSchema.parse({ ...update, chatProvider: 'bing' })).toThrow()
    expect(() => settingsUpdateSchema.parse({ ...update, qwenChatModel: 'bad\nmodel' })).toThrow()
    expect(() => settingsUpdateSchema.parse({ ...update, chatConsentVersion: -1 })).toThrow()
    const { chatProvider: _provider, qwenChatModel: _qwen, deepseekChatModel: _deepseek, chatConsentVersion: _consent, ...old } = DEFAULT_SETTINGS
    expect(appSettingsSchema.parse({ ...old, outputRoot: 'C:/papers' })).toMatchObject({ chatProvider: null, qwenChatModel: 'qwen-plus', chatConsentVersion: null })
  })
  it('enforces explicit, bounded Core RPC input/result contracts on both operations', () => {
    const payload = { documentId: doc, question: 'question', pinned: [], budgetChars: 48000 }
    expect(coreRequestSchema.parse({ version: 1, requestId: doc, operation: 'chat:build-context', payload }).payload).toEqual(payload)
    expect(paperContextRequestSchema.parse({ documentId: doc, question: 'question', pinned: [] }).budgetChars).toBe(48000)
    expect(() => coreRequestSchema.parse({ version: 1, requestId: doc, operation: 'chat:ensure-index', payload: { documentId: doc, sql: 'SELECT *' } })).toThrow()
    expect(validateCoreOperationResult('chat:ensure-index', { state: 'ready', progress: 100, contentRevisionId: 'revision1' })).toMatchObject({ state: 'ready' })
    expect(() => validateCoreOperationResult('chat:build-context', { documentId: doc, contentRevisionId: 'revision1', evidence: [], outline: [], truncated: false, key: 'secret' })).toThrow()
    expect(() => paperContextResultSchema.parse({ documentId: doc, contentRevisionId: 'revision1', evidence: [], outline: Array(129).fill('heading'), truncated: false })).toThrow()
  })
  it('checks trusted IPC senders, payload bounds and unknown request IDs through the actual registrations', async () => {
    const handlers = new Map<string, (event: IpcInvokeEventLike, request: unknown) => Promise<unknown>>()
    const service = new PaperChatService({
      saveTurn: vi.fn(), load: vi.fn(), session: vi.fn(), saveSession: vi.fn(), clear: vi.fn(), settings: vi.fn(async () => DEFAULT_SETTINGS), key: vi.fn(), buildContext: vi.fn(), stream: vi.fn(), recordUsage: vi.fn(), log: vi.fn() })
    const owner = { isDestroyed: () => false }
    const entry = resolve('renderer/index.html')
    const url = pathToFileURL(entry).href
    const frame = { url }
    const event: IpcInvokeEventLike = { sender: { mainFrame: frame, getURL: () => url, isDestroyed: () => false, send: vi.fn() }, senderFrame: frame }
    const ensureIndex = vi.fn(async () => ({ state: 'queued' as const, progress: 0, contentRevisionId: null }))
    registerPaperChatHandlers(service, ensureIndex, { getMainWindow: () => owner, fromWebContents: () => owner, rendererEntryPath: entry, ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } })
    expect([...handlers.keys()]).toEqual(['paper-chat:load', 'paper-chat:session', 'paper-chat:save-session', 'paper-chat:clear', 'paper-chat:ask', 'paper-chat:cancel', 'paper-chat:ensure-index'])
    const ask = handlers.get('paper-chat:ask')!
    await expect(ask({ ...event, senderFrame: { url } }, request)).resolves.toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
    for (const invalid of [{ question: 'a'.repeat(2001) }, { pinned: Array(9).fill(pin) }]) await expect(ask(event, { ...request, ...invalid })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    await expect(ask(event, request)).resolves.toMatchObject({ ok: false, error: { code: 'CHAT_CONSENT_REQUIRED' } })
    await expect(handlers.get('paper-chat:cancel')!(event, { requestId: doc })).resolves.toEqual({ ok: true, value: { cancelled: false } })
    await expect(handlers.get('paper-chat:ensure-index')!(event, { documentId: doc })).resolves.toMatchObject({ ok: true, value: { state: 'queued' } })
    expect(ensureIndex).toHaveBeenCalledWith(doc)
  })
  it('times out and cancels context RPC without waiting for compute work', async () => {
    vi.useFakeTimers()
    try {
      let receive!: (s: string) => void
      const sent: string[] = []
      const client = new CoreClient({ send: (s) => { sent.push(s) }, onMessage: (fn) => { receive = fn; return () => undefined } })
      receive(serializeCoreMessage(makeCoreEvent('ready')))
      const controller = new AbortController()
      const pending = client.request('chat:build-context', { documentId: doc, question: 'q', pinned: [], budgetChars: 48000 }, { signal: controller.signal })
      await vi.waitFor(() => expect(sent.some((s) => JSON.parse(s).operation === 'chat:build-context')).toBe(true))
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'CORE_CANCELLED' })
      expect(sent.some((s) => JSON.parse(s).operation === 'cancel')).toBe(true)
      const timeout = client.request('chat:ensure-index', { documentId: doc }, { timeoutMs: 20 })
      const rejection = expect(timeout).rejects.toMatchObject({ code: 'CORE_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(20); await rejection
      client.close()
    } finally { vi.useRealTimers() }
  })
})
