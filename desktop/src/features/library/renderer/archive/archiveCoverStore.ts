export type ArchiveCoverKind = 'spread' | 'single'
export interface StoredArchiveCover {
  key: string
  documentId: string
  fingerprint: string
  kind: ArchiveCoverKind
  blob: Blob
  bytes: number
  width: number
  height: number
  at: number
}

const DATABASE = 'copilotix-archive-spreads'
const MAX_BYTES = 128 * 1024 * 1024
const MAX_ITEMS = 160
let database: Promise<IDBDatabase | null> | null = null

function openStore(): Promise<IDBDatabase | null> {
  database ??= new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('covers', { keyPath: 'key' }).createIndex('at', 'at')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
  return database
}

/** The full composed cover is stored independently of the existing first-page database. */
export async function readStoredArchiveCover(key: string): Promise<StoredArchiveCover | null> {
  try {
    const db = await openStore()
    if (!db) return null
    return await new Promise<StoredArchiveCover | null>((resolve, reject) => {
      const transaction = db.transaction('covers')
      const store = transaction.objectStore('covers')
      const request = store.get(key)
      request.onsuccess = () => {
        const record = request.result as StoredArchiveCover | undefined
        if (!record || !record.blob || !['spread', 'single'].includes(record.kind)) { resolve(null); return }
        resolve(record)
        try {
          const touch = db.transaction('covers', 'readwrite')
          touch.onerror = () => undefined
          touch.onabort = () => undefined
          touch.objectStore('covers').put({ ...record, at: Date.now() })
        } catch { /* LRU maintenance must not turn a readable hit into a hanging request. */ }
      }
      request.onerror = () => reject(request.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } catch { return null }
}

export function encodeArchiveCover(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise(resolve => {
    const timer = window.setTimeout(() => resolve(null), 10_000)
    try {
      canvas.toBlob(blob => { window.clearTimeout(timer); resolve(blob) }, 'image/webp', 0.92)
    } catch { window.clearTimeout(timer); resolve(null) }
  })
}

/** Encoding/quota/IndexedDB failures leave the prepared in-memory cover usable. */
export async function writeStoredArchiveCover(record: StoredArchiveCover): Promise<void> {
  try {
    if (record.bytes > MAX_BYTES) return
    const db = await openStore()
    if (!db) return
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('covers', 'readwrite')
      const store = transaction.objectStore('covers')
      store.put(record)
      const entries: Array<{ key: IDBValidKey; bytes: number }> = []
      let bytes = 0
      const cursor = store.index('at').openCursor()
      cursor.onsuccess = () => {
        const entry = cursor.result
        if (entry) {
          const value = entry.value as StoredArchiveCover
          const size = value.bytes || value.blob.size
          entries.push({ key: entry.primaryKey, bytes: size })
          bytes += size
          entry.continue()
        } else {
          let count = entries.length
          for (const value of entries) {
            if (count <= MAX_ITEMS && bytes <= MAX_BYTES) break
            store.delete(value.key)
            count--
            bytes -= value.bytes
          }
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } catch { /* Optional renderer storage never blocks access to a paper. */ }
}

export async function decodeArchiveCover(record: StoredArchiveCover, signal: AbortSignal): Promise<HTMLCanvasElement> {
  signal.throwIfAborted()
  const validSize = (width: number, height: number): boolean => Number.isInteger(width) && Number.isInteger(height) &&
    width > 0 && width <= 8192 && height > 0 && height <= 1600 && width * height <= 16 * 1024 * 1024 &&
    (record.kind !== 'spread' || width % 2 === 0)
  if (!validSize(record.width, record.height)) throw new Error('已保存的封面尺寸无效')
  const bitmap = await createImageBitmap(record.blob)
  let canvas: HTMLCanvasElement | null = null
  try {
    signal.throwIfAborted()
    if (!validSize(bitmap.width, bitmap.height) || bitmap.width !== record.width || bitmap.height !== record.height) throw new Error('已保存的封面尺寸不匹配')
    canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context || !canvas.width || !canvas.height) throw new Error('无法读取已保存的完整封面')
    context.drawImage(bitmap, 0, 0)
    canvas.dataset.archiveCover = record.kind
    canvas.dataset.archiveCoverKey = record.key
    return canvas
  } catch (error) {
    if (canvas) { canvas.width = 0; canvas.height = 0 }
    throw error
  } finally { bitmap.close() }
}
