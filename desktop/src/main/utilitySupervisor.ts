import {
  CoreClient,
  CoreClientError,
  CORE_UNAVAILABLE,
  type CoreClientErrorCode,
  type CoreRequestOptions,
  type CoreTransport
} from '@core/coreClient'
import type {
  CoreEvent,
  CoreOperation,
  CoreOperationPayload,
  CoreOperationResult
} from '@shared/coreRpcSchemas'
import { isAbsolute } from 'node:path'

/** Minimal process surface used by the supervisor and by deterministic tests. */
export interface UtilityProcessLike {
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  on(event: 'error', listener: (...args: unknown[]) => void): this
  off?(event: 'message', listener: (message: unknown) => void): this
  off?(event: 'exit', listener: (code: number) => void): this
  off?(event: 'error', listener: (...args: unknown[]) => void): this
  removeListener?(event: 'message', listener: (message: unknown) => void): this
  removeListener?(event: 'exit', listener: (code: number) => void): this
  removeListener?(event: 'error', listener: (...args: unknown[]) => void): this
  postMessage(message: string): void
  kill(): boolean
  stderr?: {
    on(event: 'data', listener: (chunk: unknown) => void): unknown
  }
}

export type UtilityFork = (entryPath: string, args: string[], options: {
  serviceName: string
  stdio: 'ignore' | 'pipe'
}) => UtilityProcessLike

export type UtilitySupervisorState = 'idle' | 'starting' | 'ready' | 'restarting' | 'draining' | 'stopped' | 'failed'

/** Non-secret paths replayed after every utility restart. */
export interface UtilityBootstrapConfig {
  databasePath: string
  outputRoot: string
}

export interface UtilitySupervisorOptions {
  entryPath: string
  /** Inject this in tests; main supplies the Electron utilityProcess.fork adapter. */
  fork?: UtilityFork
  handshakeTimeoutMs?: number
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
  restartDelaysMs?: readonly number[]
  maxRestarts?: number
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
  now?: () => number
  onError?: (code: CoreClientErrorCode) => void
  onStateChange?: (state: UtilitySupervisorState) => void
  bootstrap?: UtilityBootstrapConfig
}

interface UtilityRecord {
  child: UtilityProcessLike
  client: CoreClient
  onExit: (code: number) => void
  onError: (...args: unknown[]) => void
  exitPromise: Promise<void>
  resolveExit: () => void
  exited: boolean
  failureHandled: boolean
  suppressRestart: boolean
}

/**
 * Owns one supervised utility process and exposes only typed Core RPC.  The
 * process adapter is injected so this module can be tested without importing
 * Electron (or starting an Electron runtime in Vitest).
 */
export class UtilitySupervisor {
  private readonly entryPath: string
  private readonly fork: UtilityFork | undefined
  private readonly handshakeTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly shutdownTimeoutMs: number
  private readonly restartDelaysMs: readonly number[]
  private readonly maxRestarts: number
  private readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  private readonly cancelSchedule: (handle: ReturnType<typeof setTimeout>) => void
  private readonly now: () => number
  private readonly errorListener?: (code: CoreClientErrorCode) => void
  private readonly stateListener?: (state: UtilitySupervisorState) => void
  private bootstrapConfig: UtilityBootstrapConfig | undefined
  private readonly eventListeners = new Set<(event: CoreEvent) => void>()
  private state: UtilitySupervisorState = 'idle'
  private record: UtilityRecord | undefined
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private restartAttempts = 0
  private startPromise: Promise<void> | undefined
  private resolveStart: (() => void) | undefined
  private rejectStart: ((reason?: unknown) => void) | undefined
  private shutdownPromise: Promise<void> | undefined
  private stopping = false
  private generation = 0

  constructor(options: UtilitySupervisorOptions) {
    this.entryPath = options.entryPath
    this.fork = options.fork
    this.handshakeTimeoutMs = positiveTimeout(options.handshakeTimeoutMs ?? 10_000, 10_000)
    this.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs ?? 30_000, 30_000)
    this.shutdownTimeoutMs = positiveTimeout(options.shutdownTimeoutMs ?? 5_000, 5_000)
    this.restartDelaysMs = options.restartDelaysMs ?? [250, 1_000, 4_000]
    this.maxRestarts = Math.max(0, Math.floor(options.maxRestarts ?? 3))
    this.schedule = options.setTimeout ?? setTimeout
    this.cancelSchedule = options.clearTimeout ?? clearTimeout
    this.now = options.now ?? Date.now
    this.errorListener = options.onError
    this.stateListener = options.onStateChange
    if (options.bootstrap) this.bootstrapConfig = validateBootstrapConfig(options.bootstrap)
  }

  getState(): UtilitySupervisorState {
    return this.state
  }

  getRestartAttempts(): number {
    return this.restartAttempts
  }

  getPendingCount(): number {
    return this.record?.client.getPendingCount() ?? 0
  }

  isStopped(): boolean {
    return this.state === 'stopped' || this.state === 'failed'
  }

  setBootstrapConfig(config: UtilityBootstrapConfig): void {
    this.bootstrapConfig = validateBootstrapConfig(config)
  }

  async start(): Promise<void> {
    if (this.state === 'ready') return
    if (this.startPromise) return this.startPromise
    if (this.stopping || (this.shutdownPromise && this.state !== 'stopped')) {
      throw new CoreClientError(CORE_UNAVAILABLE, 'Core utility is shutting down', false)
    }
    if (this.state === 'stopped' || this.state === 'failed') {
      this.restartAttempts = 0
      this.stopping = false
      this.shutdownPromise = undefined
      this.transition('idle')
    }

    this.startPromise = new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve
      this.rejectStart = reject
    })
    this.stopping = false
    this.transition('starting')
    const generation = ++this.generation
    void this.spawn(generation)
    return this.startPromise
  }

  onEvent(listener: (event: CoreEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  request<K extends CoreOperation>(
    operation: K,
    payload: CoreOperationPayload[K],
    options?: CoreRequestOptions
  ): Promise<CoreOperationResult[K]> {
    if (this.stopping || this.state !== 'ready' || !this.record) {
      return Promise.reject(new CoreClientError(CORE_UNAVAILABLE, 'Core utility is unavailable', true))
    }
    return this.record.client.request(operation, payload, options)
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shutdownPromise = this.performShutdown()
    return this.shutdownPromise
  }

  private async spawn(generation: number): Promise<void> {
    if (this.stopping || generation !== this.generation) return
    if (!this.fork) {
      this.reportError(CORE_UNAVAILABLE)
      this.scheduleRestart()
      return
    }

    let child: UtilityProcessLike
    try {
      // No process.argv, token, path, or renderer data crosses this boundary.
      child = this.fork(this.entryPath, [], {
        serviceName: 'Copilotix Core Utility',
        stdio: utilityDiagnosticsEnabled() ? 'pipe' : 'ignore'
      })
    } catch {
      this.reportError(CORE_UNAVAILABLE)
      this.scheduleRestart()
      return
    }

    let resolveExit!: () => void
    const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve })
    const record = {} as UtilityRecord
    record.child = child
    record.resolveExit = resolveExit
    record.exitPromise = exitPromise
    record.exited = false
    record.failureHandled = false
    record.suppressRestart = false
    record.onExit = (code: number): void => this.handleExit(record, code)
    record.onError = (..._args: unknown[]): void => this.handleProcessError(record)
    this.record = record
    attachUtilityDiagnostics(child)
    child.on('exit', record.onExit)
    child.on('error', record.onError)

    const transport: CoreTransport = {
      send: (message) => child.postMessage(message),
      onMessage: (listener) => {
        const onMessage = (message: unknown): void => listener(message)
        child.on('message', onMessage)
        return () => removeChildListener(child, 'message', onMessage)
      }
    }
    record.client = new CoreClient(transport, {
      handshakeTimeoutMs: this.handshakeTimeoutMs,
      requestTimeoutMs: this.requestTimeoutMs,
      onProtocolError: (error) => this.reportError(error.code),
      onStateChange: (state) => {
        if (state === 'failed') this.reportError(CORE_UNAVAILABLE)
      }
    })
    record.client.onEvent((event) => {
      for (const listener of this.eventListeners) {
        try { listener(event) } catch { /* observer failures cannot kill supervision */ }
      }
    })

    try {
      await record.client.waitReady()
    } catch {
      this.handleStartupFailure(record)
      return
    }

    if (this.bootstrapConfig) {
      try {
        await record.client.request('database:init', this.bootstrapConfig, { timeoutMs: this.handshakeTimeoutMs })
      } catch {
        this.handleStartupFailure(record)
        return
      }
    }

    if (this.record !== record || this.stopping || generation !== this.generation || record.failureHandled) {
      record.client.close()
      this.terminateRecord(record)
      return
    }
    // Restart limits apply to a consecutive failure streak.  Once a new
    // utility has completed handshake and bootstrap, a later crash gets the
    // full bounded retry budget again.
    this.restartAttempts = 0
    this.transition('ready')
    this.resolveStart?.()
    this.resolveStart = undefined
    this.rejectStart = undefined
    this.startPromise = undefined
  }

  private handleStartupFailure(record: UtilityRecord): void {
    if (record.failureHandled || this.record !== record) return
    record.failureHandled = true
    record.suppressRestart = true
    record.client.fail(new CoreClientError(CORE_UNAVAILABLE, 'Core utility failed to start', true))
    this.reportError(CORE_UNAVAILABLE)
    this.terminateRecord(record)
    if (this.record === record) this.record = undefined
    this.scheduleRestart()
  }

  private handleProcessError(record: UtilityRecord): void {
    if (record.failureHandled || this.record !== record || this.stopping) return
    record.failureHandled = true
    record.suppressRestart = true
    record.client.fail(new CoreClientError(CORE_UNAVAILABLE, 'Core utility exited unexpectedly', true))
    this.reportError(CORE_UNAVAILABLE)
    // An error event does not guarantee an immediate exit on every platform;
    // kill now so a replacement can never coexist with a zombie process.
    this.terminateRecord(record)
    if (this.record === record) this.record = undefined
    this.scheduleRestart()
  }

  private handleExit(record: UtilityRecord, _code: number): void {
    if (record.exited) return
    record.exited = true
    record.resolveExit()
    removeChildListener(record.child, 'exit', record.onExit)
    removeChildListener(record.child, 'error', record.onError)
    if (this.record !== record) return
    this.record = undefined
    if (this.stopping || record.suppressRestart) {
      if (this.stopping) this.transition('stopped')
      return
    }

    // Reject every in-flight request before scheduling a replacement.
    record.client.fail(new CoreClientError(CORE_UNAVAILABLE, 'Core utility exited unexpectedly', true))
    this.reportError(CORE_UNAVAILABLE)
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.stopping) {
      this.transition('stopped')
      return
    }
    if (this.restartTimer !== undefined) return
    if (this.restartAttempts >= this.maxRestarts) {
      this.transition('failed')
      const error = new CoreClientError(CORE_UNAVAILABLE, 'Core utility restart limit reached', true)
      this.rejectStart?.(error)
      this.resolveStart = undefined
      this.rejectStart = undefined
      this.startPromise = undefined
      return
    }

    const delay = this.restartDelaysMs[this.restartAttempts] ?? this.restartDelaysMs[this.restartDelaysMs.length - 1] ?? 4_000
    this.restartAttempts += 1
    this.transition('restarting')
    const generation = this.generation
    this.restartTimer = this.schedule(() => {
      this.restartTimer = undefined
      if (this.stopping || generation !== this.generation) return
      this.transition('starting')
      void this.spawn(generation)
    }, Math.max(0, delay))
  }

  private async performShutdown(): Promise<void> {
    this.stopping = true
    ++this.generation
    if (this.restartTimer !== undefined) {
      this.cancelSchedule(this.restartTimer)
      this.restartTimer = undefined
    }

    const record = this.record
    if (!record) {
      this.rejectStart?.(new CoreClientError(CORE_UNAVAILABLE, 'Core utility stopped before becoming ready', false))
      this.resolveStart = undefined
      this.rejectStart = undefined
      this.startPromise = undefined
      this.transition('stopped')
      return
    }

    record.suppressRestart = true
    // A utility that has not completed its handshake cannot service drain or
    // shutdown RPCs.  Closing the client first rejects waitReady(), then kill
    // the child immediately instead of waiting for the handshake timeout.
    if (record.client.getState() !== 'ready') {
      record.failureHandled = true
      const startupError = new CoreClientError(CORE_UNAVAILABLE, 'Core utility stopped before becoming ready', false)
      record.client.close()
      this.terminateRecord(record)
      if (this.record === record) this.record = undefined
      this.rejectStart?.(startupError)
      this.resolveStart = undefined
      this.rejectStart = undefined
      this.startPromise = undefined
      this.transition('stopped')
      return
    }
    this.transition('draining')
    const deadline = this.now() + this.shutdownTimeoutMs
    try {
      const drainTimeout = remainingTimeout(deadline, this.now)
      if (drainTimeout > 0) await record.client.request('drain', {}, { timeoutMs: drainTimeout })
      const shutdownTimeout = remainingTimeout(deadline, this.now)
      if (shutdownTimeout > 0) await record.client.request('shutdown', {}, { timeoutMs: shutdownTimeout })
    } catch {
      // Shutdown is best effort; the process is killed once the deadline expires.
    }

    const remaining = remainingTimeout(deadline, this.now)
    if (!record.exited && remaining > 0) await waitForExit(record, remaining, this.schedule, this.cancelSchedule)
    if (!record.exited) {
      this.terminateRecord(record)
      record.client.close()
    }
    if (this.record === record) this.record = undefined
    this.transition('stopped')
  }

  private terminateRecord(record: UtilityRecord): void {
    try { record.child.kill() } catch { /* process may already have exited */ }
    // Some test doubles and platform failures do not emit exit after kill. Do
    // not leave the old listeners attached while a replacement or app shutdown
    // proceeds.
    removeChildListener(record.child, 'exit', record.onExit)
    removeChildListener(record.child, 'error', record.onError)
  }

  private transition(state: UtilitySupervisorState): void {
    this.state = state
    try { this.stateListener?.(state) } catch { /* observer failures are isolated */ }
  }

  private reportError(code: CoreClientErrorCode): void {
    try { this.errorListener?.(code) } catch { /* observability callbacks are isolated */ }
  }
}

function removeChildListener(
  child: UtilityProcessLike,
  event: 'message' | 'exit' | 'error',
  listener: ((message: unknown) => void) | ((code: number) => void) | ((...args: unknown[]) => void)
): void {
  if (child.off) {
    if (event === 'message') child.off(event, listener as (message: unknown) => void)
    else if (event === 'exit') child.off(event, listener as (code: number) => void)
    else child.off(event, listener as (...args: unknown[]) => void)
  } else if (child.removeListener) {
    if (event === 'message') child.removeListener(event, listener as (message: unknown) => void)
    else if (event === 'exit') child.removeListener(event, listener as (code: number) => void)
    else child.removeListener(event, listener as (...args: unknown[]) => void)
  }
}

function positiveTimeout(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function utilityDiagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'test' || env.COPILOTIX_UTILITY_DIAGNOSTICS === 'true'
}

/** Return a bounded category only; never echo utility stderr or local paths. */
export function classifyUtilityDiagnostic(chunk: unknown): string {
  const text = String(chunk).slice(0, 4_096)
  if (/document(?:\.createElement|\s+is\s+not\s+defined)|\bDOM\b/iu.test(text)) return 'UTILITY_DOM_GLOBAL'
  if (/parent\s*port|parentPort/iu.test(text)) return 'UTILITY_PARENT_PORT'
  if (/MODULE_NOT_FOUND|cannot\s+find\s+module/iu.test(text)) return 'UTILITY_MODULE_LOAD'
  if (/timeout|timed\s+out/iu.test(text)) return 'UTILITY_TIMEOUT'
  if (/GPU|sandbox/iu.test(text)) return 'UTILITY_GPU'
  return 'UTILITY_STDERR'
}

function attachUtilityDiagnostics(child: UtilityProcessLike): void {
  if (!utilityDiagnosticsEnabled() || !child.stderr) return
  let emitted = 0
  child.stderr.on('data', (chunk) => {
    if (emitted >= 8) return
    emitted += 1
    console.error(`Core utility diagnostic: ${classifyUtilityDiagnostic(chunk)}`)
  })
}

function validateBootstrapConfig(config: UtilityBootstrapConfig): UtilityBootstrapConfig {
  const validatePath = (value: string): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 32_768 || value.includes('\0') || !isAbsolute(value)) {
      throw new Error('Core utility bootstrap path is invalid')
    }
    return value
  }
  return Object.freeze({ databasePath: validatePath(config.databasePath), outputRoot: validatePath(config.outputRoot) })
}

function remainingTimeout(deadline: number, now: () => number): number {
  return Math.max(0, deadline - now())
}

function waitForExit(
  record: UtilityRecord,
  delayMs: number,
  schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>,
  cancelSchedule: (handle: ReturnType<typeof setTimeout>) => void
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const timeoutHandle = schedule(() => {
      if (settled) return
      settled = true
      resolve()
    }, delayMs)
    void record.exitPromise.then(() => {
      if (settled) return
      settled = true
      cancelSchedule(timeoutHandle)
      resolve()
    })
  })
}
