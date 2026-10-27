import type { ArchivePaper } from './archiveShelves'
import { archivePaperRevision, loadArchiveDocument } from './archiveBrowseData'
import { readArchiveCoverSource, renderArchiveCover, type RenderedArchiveCover } from './archiveCover'
import { decodeArchiveCover, encodeArchiveCover, readStoredArchiveCover, writeStoredArchiveCover, type ArchiveCoverKind } from './archiveCoverStore'

export interface PreparedArchiveCover {
  key: string
  canvas: HTMLCanvasElement
  kind: ArchiveCoverKind
  release(): void
}

interface Entry {
  documentId: string
  base: string
  key: string
  canvas: HTMLCanvasElement
  kind: ArchiveCoverKind
  bytes: number
  pins: number
  invalidated: boolean
}
interface Waiter { signal: AbortSignal; resolve(cover: PreparedArchiveCover): void; reject(error: unknown): void; cancel(): void }
interface Job {
  paper: ArchivePaper
  base: string
  priority: number
  order: number
  background: boolean
  started: boolean
  attempts: number
  notBefore: number
  requeueOnAbort: boolean
  controller: AbortController
  waiters: Set<Waiter>
}

const MEMORY_BYTES = 48 * 1024 * 1024
const aborted = (message: string): DOMException => new DOMException(message, 'AbortError')
const baseKey = (paper: ArchivePaper): string => JSON.stringify(['archive-cover-v1:1600', paper.id, paper.sourceHash ?? '', archivePaperRevision(paper)])
const storedKey = (base: string, fingerprint: string): string => `${base}:${fingerprint}`

/** Complete covers prepare across the entire library; only a few decoded canvases stay in memory. */
export class ArchiveCoverService {
  private papers = new Map<string, ArchivePaper>()
  private readyIds = new Set<string>()
  private readonly completed = new Set<string>()
  private readonly hot = new Map<string, Entry>()
  private readonly retired = new Set<Entry>()
  private readonly jobs = new Map<string, Job>()
  private active: Job | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private bytes = 0
  private order = 0
  private disposed = false

  sync(papers: readonly ArchivePaper[], readyIds: ReadonlySet<string>): void {
    if (this.disposed) return
    this.papers = new Map(papers.map(paper => [paper.id, paper]))
    this.readyIds = new Set(readyIds)
    for (const [base, job] of this.jobs) {
      if (!this.current(job.paper) || !this.readyIds.has(job.paper.id)) this.cancelJob(base, job)
    }
    const versions = new Set(papers.map(baseKey))
    for (const base of this.completed) if (!versions.has(base)) this.completed.delete(base)
    for (const [base, entry] of this.hot) if (!versions.has(base)) this.retire(entry)
    for (const paper of papers) {
      const base = baseKey(paper)
      if (paper.workflow.status === 'completed' && readyIds.has(paper.id) && !this.completed.has(base) && !this.hot.has(base)) this.enqueue(paper, 2, true)
    }
    this.schedule()
  }

  prioritize(documentId: string): void {
    if (this.disposed) return
    const paper = this.papers.get(documentId)
    if (!paper || !this.readyIds.has(documentId) || this.hot.has(baseKey(paper))) return
    this.enqueue(paper, 1, true)
    this.schedule()
  }

  peek(paper: ArchivePaper): PreparedArchiveCover | null {
    if (this.disposed) return null
    const entry = this.hot.get(baseKey(paper))
    return entry && !entry.invalidated ? this.pin(entry) : null
  }

  acquire(paper: ArchivePaper, signal: AbortSignal): Promise<PreparedArchiveCover> {
    if (this.disposed || signal.aborted) return Promise.reject(signal.reason ?? aborted('Cover preparation cancelled'))
    const cached = this.peek(paper)
    if (cached) return Promise.resolve(cached)
    const tracked = this.papers.get(paper.id)
    if (tracked && baseKey(tracked) !== baseKey(paper)) return Promise.reject(aborted('Paper revision changed'))
    if (!tracked) this.papers.set(paper.id, paper)
    const job = this.enqueue(paper, 0, false)
    const result = new Promise<PreparedArchiveCover>((resolve, reject) => {
      const waiter: Waiter = { signal, resolve, reject, cancel: () => {
        job.waiters.delete(waiter)
        reject(signal.reason ?? aborted('Cover preparation cancelled'))
        if (!job.waiters.size) {
          if (job.background) job.priority = 2
          else this.cancelJob(job.base, job)
        }
      } }
      job.waiters.add(waiter)
      signal.addEventListener('abort', waiter.cancel, { once: true })
    })
    // An explicit click does not wait behind an unrelated PDF/crop job.
    if (this.active && this.active !== job && this.active.priority > 0) {
      this.active.requeueOnAbort = true
      this.active.controller.abort(aborted('An opened paper takes priority'))
    }
    this.schedule(true)
    return result
  }

  invalidate(documentId: string): void {
    if (this.disposed) return
    const paper = this.papers.get(documentId)
    for (const [base, job] of this.jobs) if (job.paper.id === documentId) this.cancelJob(base, job)
    for (const entry of this.hot.values()) if (entry.documentId === documentId) { this.completed.delete(entry.base); this.retire(entry) }
    if (paper) {
      this.completed.delete(baseKey(paper))
      if (this.readyIds.has(documentId)) this.enqueue(paper, 1, true)
    }
    this.schedule()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    for (const [base, job] of this.jobs) this.cancelJob(base, job)
    for (const entry of this.hot.values()) this.retire(entry)
    this.papers.clear()
    this.readyIds.clear()
    this.completed.clear()
    // Pinned canvases survive until the scene has released its final texture.
  }

  private current(paper: ArchivePaper): boolean {
    const latest = this.papers.get(paper.id)
    return Boolean(latest && baseKey(latest) === baseKey(paper))
  }

  private enqueue(paper: ArchivePaper, priority: number, background: boolean): Job {
    const base = baseKey(paper)
    const existing = this.jobs.get(base)
    if (existing) {
      existing.priority = Math.min(priority, existing.priority)
      existing.background ||= background
      if (priority < 2) existing.notBefore = 0
      return existing
    }
    const job: Job = { paper, base, priority, background, order: this.order++, started: false, attempts: 0,
      notBefore: 0, requeueOnAbort: false, controller: new AbortController(), waiters: new Set() }
    this.jobs.set(base, job)
    return job
  }

  private schedule(immediate = false): void {
    if (this.disposed || this.active || !this.jobs.size) return
    if (this.timer !== null) {
      if (!immediate) return
      clearTimeout(this.timer)
    }
    const jobs = [...this.jobs.values()].filter(job => !job.started)
    if (!jobs.length) { this.timer = null; return }
    const runnable = jobs.filter(job => job.notBefore <= Date.now())
    const first = runnable.length ? runnable.sort((a, b) => a.priority - b.priority || a.order - b.order)[0]!
      : jobs.sort((a, b) => a.notBefore - b.notBefore)[0]!
    const delay = Math.max(0, first.notBefore - Date.now(), first.priority === 2 && !immediate ? 80 : 0)
    this.timer = setTimeout(() => { this.timer = null; void this.drain() }, delay)
  }

  private async drain(): Promise<void> {
    if (this.disposed || this.active) return
    const available = [...this.jobs.values()].filter(job => !job.started && job.notBefore <= Date.now())
    const job = available.sort((a, b) => a.priority - b.priority || a.order - b.order)[0]
    if (!job) { this.schedule(); return }
    this.active = job
    job.started = true
    let retry = false
    try {
      const source = await readArchiveCoverSource(job.paper, job.controller.signal)
      const key = storedKey(job.base, source.fingerprint)
      const saved = await readStoredArchiveCover(key)
      job.controller.signal.throwIfAborted()
      let rendered: RenderedArchiveCover | null = null
      let reused = false
      if (saved) {
        try { rendered = { canvas: await decodeArchiveCover(saved, job.controller.signal), kind: saved.kind, fingerprint: saved.fingerprint }; reused = true }
        catch { job.controller.signal.throwIfAborted() }
      }
      if (!rendered) {
        const data = await loadArchiveDocument(job.paper.id, archivePaperRevision(job.paper))
        job.controller.signal.throwIfAborted()
        rendered = await renderArchiveCover(job.paper, data, job.controller.signal, source)
      }
      if (this.disposed || job.controller.signal.aborted || !this.current(job.paper)) {
        rendered.canvas.width = rendered.canvas.height = 0
        throw job.controller.signal.reason ?? aborted('Paper revision changed')
      }
      const finalKey = storedKey(job.base, rendered.fingerprint)
      rendered.canvas.dataset.archiveCover = rendered.kind
      rendered.canvas.dataset.archiveCoverKey = finalKey
      const entry: Entry = { documentId: job.paper.id, base: job.base, key: finalKey, canvas: rendered.canvas, kind: rendered.kind,
        bytes: rendered.canvas.width * rendered.canvas.height * 4, pins: 1, invalidated: false }
      const previous = this.hot.get(job.base)
      if (previous) this.retire(previous)
      this.hot.set(job.base, entry)
      this.bytes += entry.bytes
      this.completed.add(job.base)
      for (const waiter of job.waiters) {
        waiter.signal.removeEventListener('abort', waiter.cancel)
        if (!waiter.signal.aborted) waiter.resolve(this.pin(entry))
        else waiter.reject(waiter.signal.reason)
      }
      job.waiters.clear()
      this.trim()
      try {
        if (!reused) {
          const blob = await encodeArchiveCover(entry.canvas)
          if (blob && !job.controller.signal.aborted) await writeStoredArchiveCover({ key: finalKey, documentId: job.paper.id,
            fingerprint: rendered.fingerprint, kind: rendered.kind, blob, bytes: blob.size,
            width: entry.canvas.width, height: entry.canvas.height, at: Date.now() })
        }
      } finally { entry.pins--; if (entry.invalidated && !entry.pins) this.destroy(entry); this.trim() }
    } catch (error) {
      for (const waiter of job.waiters) { waiter.signal.removeEventListener('abort', waiter.cancel); waiter.reject(error) }
      job.waiters.clear()
      retry = job.background && this.current(job.paper) && this.readyIds.has(job.paper.id) &&
        (job.controller.signal.aborted ? job.requeueOnAbort : job.attempts < 2)
    } finally {
      if (this.jobs.get(job.base) === job) this.jobs.delete(job.base)
      this.active = null
      if (retry && !this.disposed) {
        const next = this.enqueue(job.paper, 2, true)
        next.attempts = job.attempts + (job.controller.signal.aborted ? 0 : 1)
        next.notBefore = job.controller.signal.aborted ? 0 : Date.now() + 1_000 * 2 ** job.attempts
      }
      this.schedule()
    }
  }

  private pin(entry: Entry): PreparedArchiveCover {
    entry.pins++
    this.hot.delete(entry.base)
    if (!entry.invalidated) this.hot.set(entry.base, entry)
    let released = false
    return { key: entry.key, canvas: entry.canvas, kind: entry.kind, release: () => {
      if (released) return
      released = true
      entry.pins--
      if (entry.invalidated && !entry.pins) this.destroy(entry)
      this.trim()
    } }
  }

  private trim(): void {
    for (const entry of this.hot.values()) {
      if (this.bytes <= MEMORY_BYTES) break
      if (!entry.pins) this.retire(entry)
    }
  }

  private retire(entry: Entry): void {
    if (this.hot.get(entry.base) === entry) this.hot.delete(entry.base)
    entry.invalidated = true
    if (entry.pins) this.retired.add(entry)
    else this.destroy(entry)
  }

  private destroy(entry: Entry): void {
    this.retired.delete(entry)
    this.bytes -= entry.bytes
    entry.bytes = 0
    entry.canvas.width = entry.canvas.height = 0
  }

  private cancelJob(base: string, job: Job): void {
    job.requeueOnAbort = false
    job.controller.abort(aborted('Cover preparation cancelled'))
    for (const waiter of job.waiters) { waiter.signal.removeEventListener('abort', waiter.cancel); waiter.reject(job.controller.signal.reason) }
    job.waiters.clear()
    if (this.jobs.get(base) === job) this.jobs.delete(base)
  }
}
