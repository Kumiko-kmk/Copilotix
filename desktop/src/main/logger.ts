import { appendFile } from 'node:fs/promises'

export interface TaskLogger {
  info(event: string, details?: Record<string, unknown>): void
  error(event: string, error: unknown, details?: Record<string, unknown>): void
}

export class JsonLineLogger implements TaskLogger {
  private pending = Promise.resolve()

  constructor(private readonly filePath: string) {}

  info(event: string, details: Record<string, unknown> = {}): void {
    this.write('info', event, details)
  }

  error(event: string, error: unknown, details: Record<string, unknown> = {}): void {
    this.write('error', event, { ...details, error: readableError(error) })
  }

  private write(level: 'info' | 'error', event: string, details: Record<string, unknown>): void {
    const sanitized = sanitize(details) as Record<string, unknown>
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...sanitized })}\n`
    this.pending = this.pending.then(() => appendFile(this.filePath, line, 'utf8')).catch(() => undefined)
  }
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize)
  if (!value || typeof value !== 'object') return sanitizeText(value)
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /token|authorization|api.?key|uploadUrl|resultUrl/i.test(key) ? '[REDACTED]' : sanitize(item)
    ])
  )
}

function sanitizeText(value: unknown): unknown {
  if (typeof value !== 'string') return value
  return value.replace(/https?:\/\/[^\s"']+/g, (rawUrl) => {
    try {
      const url = new URL(rawUrl)
      return `${url.origin}${url.pathname}${url.search ? '?[REDACTED]' : ''}`
    } catch {
      return '[REDACTED_URL]'
    }
  })
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
