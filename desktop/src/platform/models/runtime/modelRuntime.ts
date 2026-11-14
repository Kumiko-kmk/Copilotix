import { createHash } from 'node:crypto'
import PQueue from 'p-queue'
import { defaultConnections, type ConnectionHealth, type ModelConnection, type ModelProvider, type ModelRequest, type ModelResult, type ModelUsage } from '../contract/models'

export class ModelConnectionUnavailable extends Error {
  readonly code = 'MODEL_CONNECTION_UNAVAILABLE'
  readonly retryable = false
  constructor(readonly connectionId: string, readonly nextAllowedAt: number, readonly reason: string) {
    super(reason === 'credentials' ? '模型憑據已失效，請重新驗證' : '模型連線暫不可用，已跳過本次請求')
  }
}
interface Entry extends ConnectionHealth { config: string; probe?: Promise<void>; release?: () => void }
type Failure = 'credentials' | 'transient' | 'request' | 'cancelled'

/** One application-wide budget and circuit per connection. No retry timers or probe traffic. */
export class ModelRuntime {
  private usageObserver?: (result: Omit<ModelResult<unknown>, 'value'> & { purpose: ModelRequest['purpose'] }) => void | Promise<void>
  onUsage(observer: NonNullable<ModelRuntime['usageObserver']>): void { this.usageObserver = observer }
  private rejectedObserver?: (connectionId: string) => void | Promise<void>
  /** Called once when a connection's credentials are rejected, so settings can persist that key's state. */
  onCredentialRejected(observer: (connectionId: string) => void | Promise<void>): void { this.rejectedObserver = observer }
  private readonly entries = new Map<string, Entry>()
  private readonly queues = new Map<string, { interactive: PQueue; background: PQueue }>()
  constructor(private readonly now: () => number = Date.now) {}

  reset(connectionId: string): void {
    const old = this.entries.get(connectionId)
    this.entries.delete(connectionId)
    old?.release?.()
  }
  clear(): void { for (const id of this.entries.keys()) this.reset(id) }
  async execute<T>(request: ModelRequest, operation: (connection: ModelConnection) => Promise<{ value: T; usage: ModelUsage | null }>): Promise<ModelResult<T>> {
    let failure: unknown = new ModelConnectionUnavailable('', 0, 'unconfigured')
    const seen = new Set<string>()
    for (const connection of request.candidates) {
      if (seen.has(connection.connectionId)) continue
      seen.add(connection.connectionId)
      try {
        const result = await this.run(connection, request.lane, request.signal, () => operation(connection))
        const metadata = { provider: connection.provider, connectionId: connection.connectionId, model: request.model, completion: 'completed' as const, usage: result.usage }
        if (result.usage) await Promise.resolve().then(() => this.usageObserver?.({ ...metadata, purpose: request.purpose })).catch(() => undefined)
        return { ...result, ...metadata }
      } catch (error) {
        failure = error
        if (request.signal.aborted || error && typeof error === 'object' && 'partialOutput' in error && error.partialOutput) throw error
        if (!(error instanceof ModelConnectionUnavailable) && !['transient', 'credentials'].includes(classifyModelFailure(error, request.signal))) throw error
      }
    }
    throw failure
  }
  health(connectionId: string): ConnectionHealth {
    const e = this.entries.get(connectionId)
    return e ? { status: e.status, failures: e.failures, nextAllowedAt: e.nextAllowedAt, reason: e.reason }
      : { status: 'unknown', failures: 0, nextAllowedAt: 0 }
  }
  private entry(connection: ModelConnection): Entry {
    let e = this.entries.get(connection.connectionId)
    const config = `${connection.configVersion}:${connection.endpoint}:${connection.credentialRef}`
    if (e?.config !== config) {
      this.reset(connection.connectionId)
      e = { config, status: 'unknown', failures: 0, nextAllowedAt: 0 }
      this.entries.set(connection.connectionId, e)
    }
    return e!
  }
  private check(connection: ModelConnection, e: Entry): void {
    if (!connection.enabled || e.status === 'invalid' || e.status === 'cooldown' && e.nextAllowedAt > this.now()) {
      throw new ModelConnectionUnavailable(connection.connectionId, e.nextAllowedAt, e.reason ?? 'disabled')
    }
  }
  async run<T>(connection: ModelConnection, lane: 'interactive' | 'background', signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    const e = this.entry(connection)
    this.check(connection, e)
    while (e.probe) {
      await waitFor(e.probe, signal)
      if (this.entries.get(connection.connectionId) !== e) throw new ModelConnectionUnavailable(connection.connectionId, 0, 'configuration-changed')
      this.check(connection, e)
    }
    const probing = e.status !== 'healthy'
    if (probing) {
      e.status = 'probing'
      e.probe = new Promise<void>(resolve => { e.release = resolve })
    }
    let budget = this.queues.get(connection.quotaGroup)
    if (!budget) {
      budget = { interactive: new PQueue({ concurrency: 1 }), background: new PQueue({ concurrency: connection.provider === 'codex' ? 8 : 15 }) }
      this.queues.set(connection.quotaGroup, budget)
    }
    try {
      return await budget[lane].add(async () => {
        signal.throwIfAborted()
        this.check(connection, e)
        if (this.entries.get(connection.connectionId) !== e) throw new ModelConnectionUnavailable(connection.connectionId, 0, 'configuration-changed')
        try {
          const value = await operation()
          // Another in-flight failure must not be undone by a late successful response.
          if (e.status === 'probing' || e.status === 'healthy') Object.assign(e, { status: 'healthy', failures: 0, nextAllowedAt: 0, reason: undefined })
          return value
        } catch (error) {
          if (this.entries.get(connection.connectionId) === e) {
            const kind = classifyModelFailure(error, signal)
            if (kind === 'credentials') {
              const first = e.status !== 'invalid'
              Object.assign(e, { status: 'invalid', reason: 'credentials', nextAllowedAt: 0 })
              if (first) void Promise.resolve().then(() => this.rejectedObserver?.(connection.connectionId)).catch(() => undefined)
            }
            else if (kind === 'transient' && e.status !== 'cooldown' && e.status !== 'invalid') {
              e.failures++
              const retryAfter = numericField(error, 'retryAfterMs')
              const delay = Math.max(Math.min(300_000, 30_000 * 2 ** Math.min(e.failures - 1, 4)), retryAfter ?? 0)
              Object.assign(e, { status: 'cooldown', reason: 'connection', nextAllowedAt: this.now() + delay })
            } else if (probing && e.status === 'probing') e.status = kind === 'cancelled' ? 'unknown' : 'healthy'
          }
          throw error
        }
      }, { signal }) as T
    } finally {
      if (probing) {
        if (e.status === 'probing') e.status = 'unknown'
        const release = e.release
        e.probe = undefined; e.release = undefined
        release?.()
      }
    }
  }
}

export function classifyModelFailure(error: unknown, signal?: AbortSignal): Failure {
  if (signal?.aborted) return 'cancelled'
  const status = numericField(error, 'status')
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (status === 401 || status === 403 || /CREDENTIAL|AUTH_REQUIRED|LOGIN_REQUIRED/u.test(code)) return 'credentials'
  if (status === 408 || status === 429 || status !== undefined && status >= 500 || /RATE_LIMIT|TIMEOUT|CONNECTION|OVERLOAD|SERVER_ERROR|ECONN|ENET|EHOST|EAI_AGAIN|ENOTFOUND|UND_ERR/u.test(code)) return 'transient'
  if (status !== undefined && status >= 400) return 'request'
  if (error instanceof TypeError || error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return 'transient'
  return 'request'
}
function numericField(error: unknown, field: string): number | undefined {
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>)[field] : undefined
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
export function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
let configuredConnections: readonly ModelConnection[] = defaultConnections()
export function configureModelConnections(connections?: readonly ModelConnection[]): void { configuredConnections = connections ?? defaultConnections() }
export function connectionFor(provider: ModelProvider, endpoint: string, credential: string, configured?: readonly ModelConnection[]): ModelConnection {
  const base = (configured ?? configuredConnections).find(value => value.provider === provider && value.connectionId === `${provider}:default`)
    ?? defaultConnections().find(value => value.provider === provider)!
  return keyConnection({ ...base, endpoint }, credential)
}
/** Binds a stored connection to its current key, so replacing the key resets only that connection's health. */
export function keyConnection(connection: ModelConnection, credential: string): ModelConnection {
  return { ...connection, configVersion: createHash('sha256').update(`${connection.configVersion}\0${connection.endpoint}\0${credential}`).digest('hex') }
}
export const sharedModelRuntime = new ModelRuntime()
