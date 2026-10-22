import { DEFAULT_SETTINGS } from '../src/shared/constants'
import { describe, expect, it, vi } from 'vitest'
import { IpcClientError, ipcFailure, ipcSuccess } from '../src/shared/ipc'
import { appSettingsSchema, ipcEnvelopeSchema, importDocumentsIpcRequestSchema, settingsUpdateSchema, windowStateSchema, documentChangeEventSchema, documentSummarySchema, mutateReaderAnnotationsRequestSchema, readerAnnotationSnapshotSchema, type DocumentSummary } from '../src/shared/ipcSchemas'
import { decodeIpcEvent, decodeIpcResponse } from '../src/preload/ipcClient'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertTrustedSender, isTrustedRendererUrl, registerValidatedHandler, toIpcError, type IpcInvokeEventLike, type IpcMainLike } from '../src/main/ipc'
import { z } from 'zod'
import { computeDocumentChange } from '../src/main/documentProjection'
import { randomUUID } from 'node:crypto'
import { registerPaperInsightHandlers } from '../src/main/chat/paperInsightIpc'
import { type PaperInsightService } from '../src/main/chat/paperInsightService'
import { paperInsightChangedSchema } from '../src/shared/paperInsight'

describe("ipcContracts", () => {
  describe('IPC contracts', () => {
    it('round-trips a validated success envelope and rejects unknown fields', () => {
      const state = { maximized: true }
      const envelope = ipcEnvelopeSchema(windowStateSchema).parse(ipcSuccess(state))
      expect(decodeIpcResponse(envelope, windowStateSchema)).toEqual(state)
      expect(() => settingsUpdateSchema.parse({ outputRoot: 'C:/papers', unexpected: true })).toThrow()
    })

    it('turns a failure envelope into a typed client error', () => {
      const envelope = ipcEnvelopeSchema(windowStateSchema).parse(
        ipcFailure({ code: 'HANDLER_ERROR', message: '操作失败', retryable: true, traceId: 'trace-1' })
      )
      expect(() => decodeIpcResponse(envelope, windowStateSchema)).toThrow(IpcClientError)
      try {
        decodeIpcResponse(envelope, windowStateSchema)
      } catch (error) {
        expect(error).toMatchObject({ name: 'IpcClientError', code: 'HANDLER_ERROR', traceId: 'trace-1' })
      }
    })

    it('drops malformed event payloads before they reach renderer listeners', () => {
      expect(decodeIpcEvent(ipcSuccess({ maximized: false }), windowStateSchema)).toEqual({ maximized: false })
      expect(decodeIpcEvent({ ok: true, value: { maximized: 'yes' } }, windowStateSchema)).toBeNull()
      expect(decodeIpcEvent({ maximized: true }, windowStateSchema)).toBeNull()
    })

    it('keeps settings response fields explicit at runtime', () => {
      const settings = {
        ...DEFAULT_SETTINGS,
        outputRoot: 'C:/papers',
        formulaEnabled: true,
        tableEnabled: true,
        translationProvider: 'qwen' as const,
        translationProviderOrder: ['qwen', 'deepseek', 'bing', 'transmart'] as const,
        enabledTranslationProviders: ['qwen', 'deepseek', 'bing', 'transmart'] as const,
        qwenBaseUrl: 'https://example.com',
        qwenModel: 'qwen',
        deepseekBaseUrl: 'https://example.com',
        deepseekModel: 'deepseek',
        credentials: {
          parser: { state: 'missing' as const },
          qwen: { state: 'unknown' as const, maskedValue: 'sk-****-key' },
          deepseek: { state: 'valid' as const, maskedValue: 'deep****seek' }
        }
      }
      expect(appSettingsSchema.parse(settings)).toEqual(settings)
    })

    it('pairs per-file import options with paths and keeps requests without them valid', () => {
      expect(importDocumentsIpcRequestSchema.parse({ options: {}, paths: ['C:/papers/a.pdf'] })).toEqual({ options: {}, paths: ['C:/papers/a.pdf'] })
      expect(importDocumentsIpcRequestSchema.parse({ options: {}, paths: ['C:/papers/a.pdf'], files: [{ skipFirstPage: true, metadataTitle: 'A Paper Title' }] }).files)
        .toEqual([{ skipFirstPage: true, metadataTitle: 'A Paper Title' }])
      expect(() => importDocumentsIpcRequestSchema.parse({ options: {}, paths: ['C:/papers/a.pdf', 'C:/papers/b.pdf'], files: [{}] })).toThrow()
      expect(() => importDocumentsIpcRequestSchema.parse({ options: {}, files: [{}] })).toThrow()
      expect(() => importDocumentsIpcRequestSchema.parse({ options: {}, paths: ['C:/papers/a.pdf'], files: [{ pages: 2 }] })).toThrow()
    })

    it('rejects NUL characters in paths and path-derived names', () => {
      expect(() => importDocumentsIpcRequestSchema.parse({ options: {}, paths: ['C:/papers/bad\0.pdf'] })).toThrow()
      expect(() => settingsUpdateSchema.parse({
        outputRoot: 'C:/papers\0bad',
        formulaEnabled: true,
        tableEnabled: true,
        translationProvider: 'qwen',
        qwenBaseUrl: 'https://example.com',
        qwenModel: 'qwen',
        deepseekBaseUrl: 'https://example.com',
        deepseekModel: 'deepseek'
      })).toThrow()
    })
  })
})

describe("ipcValidation", () => {
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
})

describe("documentContracts", () => {
  const documentId = '11111111-1111-4111-8111-111111111111'
  const artifactId = '22222222-2222-4222-8222-222222222222'

  function summary(overrides: Record<string, unknown> = {}) {
    return {
      id: documentId,
      originalName: 'paper.pdf',
      displayName: 'paper.pdf',
      sourceHash: 'source-hash',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      workflow: { status: 'parsing', progress: 10, activeJobKind: 'parse', error: null },
      processing: { translationProvider: 'qwen' },
      ...overrides
    }
  }

  function annotation(overrides: Record<string, unknown> = {}) {
    return {
      id: '33333333-3333-4333-8333-333333333333',
      documentId,
      artifactId,
      view: 'original',
      kind: 'highlight',
      color: 'yellow',
      blockKey: 'content:0',
      startOffset: 0,
      endOffset: 5,
      quote: 'alpha',
      prefix: '',
      suffix: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides
    }
  }

  describe('v2 document IPC schemas', () => {
    it('uses strict UUID, NUL, length, and array bounds', () => {
      expect(documentSummarySchema.parse(summary()).id).toBe(documentId)
      expect(() => documentSummarySchema.parse(summary({ extra: true }))).toThrow()
      expect(() => documentSummarySchema.parse(summary({ id: 'document-1' }))).toThrow()
      expect(() => documentSummarySchema.parse(summary({ originalName: 'bad\0.pdf' }))).toThrow()
      expect(() => documentSummarySchema.parse(summary({ workflow: { status: 'parsing', progress: 101, activeJobKind: 'parse', error: null } }))).toThrow()

      const tooMany = Array.from({ length: 1_001 }, (_, index) => ({ ...summary(), id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}` }))
      expect(() => documentChangeEventSchema.parse({ revision: 1, upserted: tooMany, removedIds: [] })).toThrow()
    })

    it('requires annotation identity to match its mutation envelope', () => {
      const valid = {
        documentId,
        artifactId,
        view: 'original' as const,
        expectedRevision: 0,
        upserts: [annotation()],
        deleteIds: []
      }
      expect(mutateReaderAnnotationsRequestSchema.parse(valid)).toEqual(valid)
      expect(() => mutateReaderAnnotationsRequestSchema.parse({
        ...valid,
        upserts: [annotation({ documentId: '44444444-4444-4444-8444-444444444444' })]
      })).toThrow()
      expect(() => mutateReaderAnnotationsRequestSchema.parse({
        ...valid,
        upserts: [annotation()],
        deleteIds: [annotation().id]
      })).toThrow()
      expect(() => mutateReaderAnnotationsRequestSchema.parse({
        ...valid,
        upserts: [annotation({ quote: 'a\0pha' })]
      })).toThrow()
    })

    it('keeps the reader snapshot shape path-free and strict', () => {
      const value = {
        documentId,
        artifactId,
        view: 'original' as const,
        revision: 1,
        annotations: [annotation()]
      }
      expect(readerAnnotationSnapshotSchema.parse(value)).toEqual(value)
      expect(() => readerAnnotationSnapshotSchema.parse({ ...value, outputDir: 'C:/secret' })).toThrow()
    })
  })
})

describe("documentProjection", () => {
  const first: DocumentSummary = {
    id: '11111111-1111-4111-8111-111111111111',
    originalName: 'first.pdf',
    displayName: 'first.pdf',
    sourceHash: 'hash-first',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    workflow: { status: 'parsing', progress: 10, activeJobKind: 'parse', error: null },
    processing: { translationProvider: 'qwen' }
  }
  const second: DocumentSummary = {
    ...first,
    id: '22222222-2222-4222-8222-222222222222',
    originalName: 'second.pdf'
  }

  describe('document list change projection', () => {
    it('does not advance the revision for a no-op', () => {
      const result = computeDocumentChange(new Map([[first.id, first]]), [first], 7)
      expect(result.event).toBeNull()
      expect(result.next).toEqual(new Map([[first.id, first]]))
    })

    it('emits ordered upserts and removals with a monotonic revision', () => {
      const changed = { ...first, workflow: { ...first.workflow, progress: 25 } }
      const result = computeDocumentChange(new Map([[first.id, first], [second.id, second]]), [changed], 7)
      expect(result.event).toEqual({ revision: 8, upserted: [changed], removedIds: [second.id] })
      expect(result.next).toEqual(new Map([[first.id, changed]]))
    })

    it('rejects duplicate IDs instead of broadcasting an ambiguous diff', () => {
      expect(() => computeDocumentChange(new Map(), [first, first], 0)).toThrow()
    })

    it('models terminal and queued workflow states without leaking processing details', () => {
      expect(first.workflow.activeJobKind).toBe('parse')
      expect({ ...first, workflow: { ...first.workflow, status: 'completed', activeJobKind: null } }.workflow.activeJobKind).toBeNull()
      expect({ ...first, workflow: { ...first.workflow, status: 'queued' } }.workflow.status).toBe('queued')
      expect(Object.keys(documentSummarySchema.parse(first))).toEqual(['id', 'originalName', 'displayName', 'sourceHash', 'workflow', 'processing', 'createdAt', 'updatedAt'])
    })
  })
})

describe("paperInsightIpc", () => {
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
})
