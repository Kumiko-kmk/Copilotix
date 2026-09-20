import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CopilotixTask, TranslationProviderId } from '@shared/types'
import type { UsageAnalytics } from '@shared/ipcSchemas'

interface StoredUsageAnalytics {
  version: 1
  pagesByDocument: Record<string, { date: string; pages: number }>
  tokenDays: Record<string, { deepseek: number; qwen: number }>
}

export interface ProviderTokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface UsageAnalyticsRecorder {
  recordDocumentPages(documentId: string, createdAt: string, pages: number): Promise<void>
  recordTokens(provider: TranslationProviderId, usage: ProviderTokenUsage, at?: Date): Promise<void>
}

const EMPTY_STATE: StoredUsageAnalytics = { version: 1, pagesByDocument: {}, tokenDays: {} }

export class UsageAnalyticsService implements UsageAnalyticsRecorder {
  private readonly statePromise: Promise<StoredUsageAnalytics>
  private writeTail = Promise.resolve()

  constructor(private readonly filePath: string) {
    this.statePromise = this.load()
  }

  async recordDocumentPages(documentId: string, createdAt: string, pages: number): Promise<void> {
    if (!documentId || !Number.isSafeInteger(pages) || pages < 0) return
    const state = await this.statePromise
    state.pagesByDocument[documentId] = { date: localDateKey(new Date(createdAt)), pages }
    await this.persist(state)
  }

  async recordTokens(provider: TranslationProviderId, usage: ProviderTokenUsage, at = new Date()): Promise<void> {
    if (provider !== 'deepseek' && provider !== 'qwen') return
    const total = nonNegativeInteger(usage.totalTokens)
    if (total === 0) return
    const state = await this.statePromise
    const date = localDateKey(at)
    const current = state.tokenDays[date] ?? { deepseek: 0, qwen: 0 }
    current[provider] = safeAdd(current[provider], total)
    state.tokenDays[date] = current
    await this.persist(state)
  }

  async snapshot(tasks: readonly CopilotixTask[], dayCount = 84, now = new Date()): Promise<UsageAnalytics> {
    const state = await this.statePromise
    const days = buildDayRange(dayCount, now)
    const byDate = new Map(days.map((date) => [date, { date, documents: 0, pages: 0, deepseekTokens: 0, qwenTokens: 0 }]))
    for (const task of tasks) {
      const day = byDate.get(localDateKey(new Date(task.createdAt)))
      if (day) day.documents += 1
    }
    for (const entry of Object.values(state.pagesByDocument)) {
      const day = byDate.get(entry.date)
      if (day) day.pages = safeAdd(day.pages, entry.pages)
    }
    for (const [date, tokens] of Object.entries(state.tokenDays)) {
      const day = byDate.get(date)
      if (!day) continue
      day.deepseekTokens = nonNegativeInteger(tokens.deepseek)
      day.qwenTokens = nonNegativeInteger(tokens.qwen)
    }
    return { days: [...byDate.values()] }
  }

  private async load(): Promise<StoredUsageAnalytics> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StoredUsageAnalytics>
      if (parsed.version !== 1 || !isRecord(parsed.pagesByDocument) || !isRecord(parsed.tokenDays)) return structuredClone(EMPTY_STATE)
      return {
        version: 1,
        pagesByDocument: sanitizePages(parsed.pagesByDocument),
        tokenDays: sanitizeTokens(parsed.tokenDays)
      }
    } catch {
      return structuredClone(EMPTY_STATE)
    }
  }

  private persist(state: StoredUsageAnalytics): Promise<void> {
    const snapshot = JSON.stringify(state)
    this.writeTail = this.writeTail.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, snapshot, 'utf8')
    })
    return this.writeTail
  }
}

function buildDayRange(count: number, now: Date): string[] {
  const safeCount = Math.max(1, Math.min(366, Math.trunc(count)))
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  cursor.setDate(cursor.getDate() - safeCount + 1)
  return Array.from({ length: safeCount }, () => {
    const key = localDateKey(cursor)
    cursor.setDate(cursor.getDate() + 1)
    return key
  })
}

function localDateKey(date: Date): string {
  if (!Number.isFinite(date.getTime())) return '1970-01-01'
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function safeAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, nonNegativeInteger(left) + nonNegativeInteger(right))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function sanitizePages(value: Record<string, unknown>): StoredUsageAnalytics['pagesByDocument'] {
  const result: StoredUsageAnalytics['pagesByDocument'] = {}
  for (const [id, candidate] of Object.entries(value).slice(0, 10_000)) {
    if (!isRecord(candidate) || typeof candidate.date !== 'string') continue
    result[id] = { date: candidate.date.slice(0, 10), pages: nonNegativeInteger(candidate.pages) }
  }
  return result
}

function sanitizeTokens(value: Record<string, unknown>): StoredUsageAnalytics['tokenDays'] {
  const result: StoredUsageAnalytics['tokenDays'] = {}
  for (const [date, candidate] of Object.entries(value).slice(-366)) {
    if (!isRecord(candidate)) continue
    result[date.slice(0, 10)] = { deepseek: nonNegativeInteger(candidate.deepseek), qwen: nonNegativeInteger(candidate.qwen) }
  }
  return result
}
