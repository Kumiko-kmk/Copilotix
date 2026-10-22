import { randomUUID } from 'node:crypto'
import { ZoteroUnavailableError } from './zoteroCatalog'

/**
 * Zotero's local connector (the one browser extensions use; on whenever Zotero runs). Verified
 * against Zotero 9.0.6: `saveItems` creates items (child `notes` included, `itemType: 'note'` is a
 * standalone note) in the collection selected in Zotero, and `saveAttachment` streams a PDF onto
 * an item created in the same session. Nothing here can address an existing Zotero item.
 */
export interface ZoteroConnectorItem {
  id: string
  itemType: string
  title?: string
  note?: string
  abstractNote?: string
  extra?: string
  tags?: Array<{ tag: string }>
  notes?: Array<{ note: string }>
}

export interface ZoteroConnector {
  ping(): Promise<void>
  /** Saves items in one new session and returns the session ID for attachments. */
  saveItems(items: ZoteroConnectorItem[]): Promise<string>
  saveAttachment(sessionID: string, parentItemID: string, title: string, pdf: Buffer): Promise<void>
}

const CONNECTOR_TIMEOUT_MS = 15_000
const ATTACHMENT_TIMEOUT_MS = 120_000

export function createZoteroConnector(port: number, fetchImpl: typeof fetch = fetch): ZoteroConnector {
  const base = `http://127.0.0.1:${port}/connector`
  // Requests that look like they come from a browser are dropped unless they carry this header.
  const headers = { 'Zotero-Allowed-Request': '1' }
  const post = async (path: string, body: BodyInit, extra: Record<string, string>, timeout = CONNECTOR_TIMEOUT_MS): Promise<Response> => {
    try {
      return await fetchImpl(`${base}${path}`, { method: 'POST', headers: { ...headers, ...extra }, body, signal: AbortSignal.timeout(timeout) })
    } catch {
      throw new ZoteroUnavailableError('无法连接 Zotero，请先打开 Zotero 再导出')
    }
  }
  const expect = async (response: Response, statuses: number[], action: string): Promise<void> => {
    if (statuses.includes(response.status)) return
    const detail = (await response.text().catch(() => '')).slice(0, 200)
    throw new Error(`Zotero ${action}失败（${response.status}${detail ? `：${detail}` : ''}）`)
  }
  return {
    async ping() {
      await expect(await post('/ping', '{}', { 'Content-Type': 'application/json' }), [200], '连接')
    },
    async saveItems(items) {
      const sessionID = randomUUID()
      const response = await post('/saveItems', JSON.stringify({ sessionID, uri: 'copilotix://export', items }), { 'Content-Type': 'application/json' })
      if (response.status === 500 && (await response.clone().text()).includes('libraryEditable')) throw new Error('Zotero 当前选中的文库不可编辑')
      await expect(response, [201], '保存条目')
      return sessionID
    },
    async saveAttachment(sessionID, parentItemID, title, pdf) {
      const response = await post(`/saveAttachment?sessionID=${encodeURIComponent(sessionID)}`, new Uint8Array(pdf), {
        'Content-Type': 'application/pdf',
        'X-Metadata': JSON.stringify({ sessionID, parentItemID, title, url: 'copilotix://export/original.pdf' })
      }, ATTACHMENT_TIMEOUT_MS)
      // 200 means the library does not accept files; the item itself was still created.
      if (response.status === 200) throw new Error('Zotero 当前文库不接受附件文件')
      await expect(response, [201], '上传 PDF ')
    }
  }
}
