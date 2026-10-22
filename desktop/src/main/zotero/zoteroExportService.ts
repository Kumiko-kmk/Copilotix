import { readFile } from 'node:fs/promises'
import type { ZoteroExportRequest, ZoteroExportResult, ZoteroLink } from '@shared/zotero'
import type { ZoteroConnector } from './zoteroConnector'
import { addZoteroExport, readZoteroExports, readZoteroLinks } from './zoteroLinks'

/** What Copilotix knows about one paper, gathered by Main from the library. */
export interface ZoteroExportContent {
  title: string
  translatedTitle: string | null
  abstract: string | null
  summary: string | null
  highlights: Array<{ view: 'original' | 'translated'; quote: string }>
  notes: Array<{ quote: string; body: string }>
}

export interface ZoteroExportDependencies {
  connector(): Promise<ZoteroConnector>
  getDocument(documentId: string): Promise<{ id: string; outputDir: string; sourcePath: string; displayName: string } | null>
  gatherContent(documentId: string): Promise<ZoteroExportContent>
  readPdf?(path: string): Promise<Buffer>
  now?(): Date
}

const MAX_HIGHLIGHTS = 500
const MAX_QUOTE_CHARS = 2_000

/**
 * Copilotix → Zotero through the local connector. A paper imported from Zotero gets a standalone
 * note carrying a zotero://select link to its item (the connector cannot add children to an
 * existing item); any other paper becomes a new item with its PDF and the same note as a child.
 */
export class ZoteroExportService {
  constructor(private readonly deps: ZoteroExportDependencies) {}

  async exportDocuments(request: ZoteroExportRequest): Promise<ZoteroExportResult> {
    const connector = await this.deps.connector()
    await connector.ping()
    const result: ZoteroExportResult = { notes: 0, items: 0, skipped: [], failed: [] }
    for (const documentId of new Set(request.documentIds)) {
      const document = await this.deps.getDocument(documentId)
      if (!document) {
        result.failed.push({ name: documentId, message: '论文不存在' })
        continue
      }
      try {
        if (!request.repeat && (await readZoteroExports(document.outputDir)).length > 0) {
          result.skipped.push(documentId)
          continue
        }
        const content = await this.deps.gatherContent(documentId)
        const link = (await readZoteroLinks(document.outputDir)).find((entry) => entry.groupID === null)
        const html = buildZoteroNoteHtml(content, link)
        if (link) {
          await connector.saveItems([{ id: 'copilotix-note', itemType: 'note', note: html }])
          result.notes += 1
        } else {
          const sessionID = await connector.saveItems([{
            id: 'copilotix-item',
            itemType: 'document',
            title: content.title || document.displayName.replace(/\.pdf$/iu, ''),
            ...(content.abstract ? { abstractNote: content.abstract.slice(0, 10_000) } : {}),
            extra: 'Exported from Copilotix',
            notes: [{ note: html }]
          }])
          result.items += 1
          try {
            await connector.saveAttachment(sessionID, 'copilotix-item', 'PDF', await (this.deps.readPdf ?? readFile)(document.sourcePath))
          } catch (error) {
            // The item exists in Zotero now; record it so a retry does not create a second one.
            await this.record(document.outputDir, 'item')
            throw new Error(`条目已在 Zotero 建立，但 PDF 未能附上：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        await this.record(document.outputDir, link ? 'note' : 'item')
      } catch (error) {
        result.failed.push({ name: document.displayName, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return result
  }

  private async record(outputDir: string, kind: 'note' | 'item'): Promise<void> {
    await addZoteroExport(outputDir, { kind, exportedAt: (this.deps.now?.() ?? new Date()).toISOString() })
  }
}

export function buildZoteroNoteHtml(content: ZoteroExportContent, link?: ZoteroLink): string {
  const parts = [`<h1>Copilotix：${escapeHtml(content.title)}</h1>`]
  if (link) parts.push(`<p><a href="zotero://select/library/items/${link.itemKey}">打开 Zotero 原条目</a></p>`)
  if (content.translatedTitle) parts.push('<h2>译名</h2>', `<p>${escapeHtml(content.translatedTitle)}</p>`)
  if (content.summary) parts.push('<h2>AI 总结</h2>', `<p>${escapeHtml(content.summary)}</p>`)
  const highlights = content.highlights.slice(0, MAX_HIGHLIGHTS)
  if (highlights.length > 0) {
    parts.push('<h2>高亮</h2>', '<ul>', ...highlights.map((item) => `<li>${item.view === 'translated' ? '［译文］' : ''}${escapeHtml(clip(item.quote))}</li>`), '</ul>')
    if (content.highlights.length > MAX_HIGHLIGHTS) parts.push(`<p>另有 ${content.highlights.length - MAX_HIGHLIGHTS} 条高亮未导出</p>`)
  }
  if (content.notes.length > 0) {
    parts.push('<h2>笔记</h2>')
    for (const note of content.notes) parts.push(`<blockquote>${escapeHtml(clip(note.quote))}</blockquote>`, `<p>${escapeHtml(note.body).replace(/\n/gu, '<br>')}</p>`)
  }
  return parts.join('')
}

function clip(text: string): string {
  return text.length > MAX_QUOTE_CHARS ? `${text.slice(0, MAX_QUOTE_CHARS)}…` : text
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}
