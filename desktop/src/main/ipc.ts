import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { z } from 'zod'
import { ipcFailure, ipcSuccess } from '@shared/ipc'
import { ipcEnvelopeSchema } from '@shared/ipcSchemas'

export interface WebFrameLike {
  url: string
}

export interface WebContentsLike {
  mainFrame: WebFrameLike
  getURL(): string
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): unknown
}

export interface WindowLike {
  isDestroyed(): boolean
}

export interface IpcInvokeEventLike {
  sender: WebContentsLike
  senderFrame: WebFrameLike | null
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcInvokeEventLike, request: unknown) => Promise<unknown>): void
}

export interface IpcValidationOptions {
  gate?: { run<T>(channel: string, operation: () => T | Promise<T>): Promise<T> }
  getMainWindow: () => WindowLike | null
  rendererEntryPath: string
  rendererOrigin?: string
  fromWebContents?: (contents: WebContentsLike) => WindowLike | null
  ipcMain?: IpcMainLike
}

export function isTrustedRendererUrl(url: string, options: Pick<IpcValidationOptions, 'rendererEntryPath' | 'rendererOrigin'>): boolean {
  if (options.rendererOrigin) {
    try {
      return new URL(url).origin === new URL(options.rendererOrigin).origin
    } catch {
      return false
    }
  }

  try {
    const parsed = new URL(url)
    return parsed.protocol === 'file:' && !parsed.search && !parsed.hash && fileURLToPath(parsed) === options.rendererEntryPath
  } catch {
    return false
  }
}

export function assertTrustedSender(event: IpcInvokeEventLike, options: IpcValidationOptions): void {
  const owner = options.getMainWindow()
  const fromWebContents = options.fromWebContents ?? ((contents: WebContentsLike) =>
    BrowserWindow.fromWebContents(contents as unknown as WebContents))
  const sourceWindow = fromWebContents(event.sender)
  if (!owner || owner.isDestroyed() || sourceWindow !== owner) {
    throw new Error('IPC 请求来源无效')
  }

  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('IPC 请求必须来自主 frame')
  }

  const senderUrl = event.senderFrame?.url || event.sender.getURL()
  if (!isTrustedRendererUrl(senderUrl, options)) {
    throw new Error('IPC 请求页面来源无效')
  }
}

export function toIpcError(
  error: unknown,
  code = 'INTERNAL_ERROR',
  traceId = randomUUID()
): { code: string; message: string; retryable: boolean; traceId: string } {
  const domainCode = error && typeof error === 'object' && 'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null
  const resolvedCode = domainCode && code === 'HANDLER_ERROR' ? domainCode : code
  const retryable = resolvedCode === 'INTERNAL_ERROR' || resolvedCode === 'HANDLER_ERROR'
  if (error instanceof z.ZodError) {
    return { code, message: 'IPC 请求格式无效', retryable: false, traceId }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { code: resolvedCode, message: message || 'IPC 请求失败', retryable, traceId }
}

export function registerValidatedHandler<Request, Response>(
  channel: string,
  requestSchema: z.ZodType<Request>,
  responseSchema: z.ZodType<Response>,
  handler: (event: IpcInvokeEventLike, request: Request) => Promise<Response> | Response,
  options: IpcValidationOptions
): void {
  const registrar = options.ipcMain ?? {
    handle: (registeredChannel: string, listener: (event: IpcInvokeEventLike, request: unknown) => Promise<unknown>) => {
      ipcMain.handle(registeredChannel, (event, request) =>
        listener({ sender: event.sender, senderFrame: event.senderFrame }, request))
    }
  }
  registrar.handle(channel, async (event, rawRequest) => {
    const traceId = randomUUID()
    try {
      assertTrustedSender(event, options)
    } catch (error) {
      return ipcFailure(toIpcError(error, 'UNTRUSTED_SENDER', traceId))
    }

    let request: Request
    try {
      request = requestSchema.parse(rawRequest)
    } catch (error) {
      return ipcFailure(toIpcError(error, 'INVALID_REQUEST', traceId))
    }

    let result: Response
    try {
      result = options.gate ? await options.gate.run(channel, () => handler(event, request)) : await handler(event, request)
    } catch (error) {
      return ipcFailure(toIpcError(error, 'HANDLER_ERROR', traceId))
    }

    try {
      return ipcSuccess(responseSchema.parse(result))
    } catch (error) {
      return ipcFailure(toIpcError(error, 'INVALID_RESPONSE', traceId))
    }
  })
}

export function sendValidatedEvent<T>(
  contents: WebContentsLike,
  channel: string,
  schema: z.ZodType<T>,
  value: T
): void {
  if (contents.isDestroyed()) return
  contents.send(channel, ipcEnvelopeSchema(schema).parse(ipcSuccess(value)))
}

export function rendererValidationOptions(getMainWindow: () => WindowLike | null): IpcValidationOptions {
  return {
    getMainWindow,
    rendererEntryPath: requireRendererEntryPath(),
    rendererOrigin: process.env.ELECTRON_RENDERER_URL
  }
}

function requireRendererEntryPath(): string {
  return resolve(__dirname, '../renderer/index.html')
}
