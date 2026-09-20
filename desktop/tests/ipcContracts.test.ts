import { describe, expect, it } from 'vitest'
import { IpcClientError, ipcFailure, ipcSuccess } from '../src/shared/ipc'
import {
  appSettingsSchema,
  ipcEnvelopeSchema,
  inspectPdfsRequestSchema,
  settingsUpdateSchema,
  windowStateSchema
} from '../src/shared/ipcSchemas'
import { decodeIpcEvent, decodeIpcResponse } from '../src/preload/ipcClient'

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

  it('rejects NUL characters in paths and path-derived names', () => {
    expect(() => inspectPdfsRequestSchema.parse(['C:/papers/bad\0.pdf'])).toThrow()
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
