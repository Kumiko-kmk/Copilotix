import type { DocumentBase, DocumentModelDescriptor } from '../contract/documentModel'
const pending = new Map<string, Promise<DocumentBase>>()
export async function loadDocumentBase<T extends { modelDescriptor?: DocumentModelDescriptor; assetBaseUrl: string }>(document: T): Promise<T & { base?: DocumentBase }> {
  const descriptor = document.modelDescriptor
  if (!descriptor) return document
  const key = descriptor.documentId + ':' + descriptor.digest
  let request = pending.get(key)
  if (!request) {
    request = (async () => {
      const response = await fetch(document.assetBaseUrl + descriptor.path + '?v=' + descriptor.sourceVersion)
      if (!response.ok) throw new Error('无法读取文档模型')
      const raw = await response.json() as { base: DocumentBase; digest: string }
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(raw.base)))
      const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      if (actual !== descriptor.digest || raw.base.documentId !== descriptor.documentId || raw.base.sourceVersion !== descriptor.sourceVersion) throw new Error('文档模型已变化，请重新读取')
      return raw.base
    })()
    pending.set(key, request)
    const clear = () => { if (pending.get(key) === request) pending.delete(key) }
    void request.then(clear, clear)
  }
  return { ...document, base: await request }
}
