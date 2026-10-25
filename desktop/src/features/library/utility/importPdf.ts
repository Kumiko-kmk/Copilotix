import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MAX_PDF_BYTES } from '@shared/constants'
import { MAX_PDF_CROP_BYTES } from '../contract/pdfImport'
import { CoreUtilityOperationError } from '@platform/rpc/utility/coreUtilityRuntime'
import { PathPolicy } from '@platform/files/runtime/pathPolicy'
import { withoutFirstPage } from './pdfPageRemoval'
import { isNotFound } from '@platform/files/utility/fileHash'

/** Copy an imported PDF into the library (optionally without its first page), hashed and published atomically. */


export async function importPdf(
  sourcePath: string,
  documentId: string,
  state: { outputRoot?: string },
  signal: AbortSignal,
  skipFirstPage = false
): Promise<{ sha256: string; size: number }> {
  if (!isAbsolute(sourcePath) || sourcePath.length > 32_768 || sourcePath.includes('\0') || extname(sourcePath).toLowerCase() !== '.pdf') {
    throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Invalid PDF import request', false)
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(documentId)) {
    throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Invalid document identifier', false)
  }
  if (!state.outputRoot || !isAbsolute(state.outputRoot) || state.outputRoot.length > 32_768 || state.outputRoot.includes('\0')) {
    throw new CoreUtilityOperationError('CORE_UNAVAILABLE', 'Core output directory is unavailable', true)
  }

  let sourceInfo
  try {
    sourceInfo = await lstat(sourcePath)
  } catch {
    throw new CoreUtilityOperationError('CORE_NOT_FOUND', 'PDF source is unavailable', false)
  }
  if (!sourceInfo.isFile()) throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'PDF source must be a regular file', false)
  if (sourceInfo.size === 0) throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'PDF source is empty', false)
  if (sourceInfo.size > MAX_PDF_BYTES) throw new CoreUtilityOperationError('CORE_LIMIT_EXCEEDED', 'PDF exceeds the supported size limit', false)
  const policy = new PathPolicy()
  await mkdir(state.outputRoot, { recursive: true })
  const documentsRoot = policy.resolveChild(state.outputRoot, 'documents-v2')
  await mkdir(documentsRoot, { recursive: true })
  const documentRoot = policy.resolveChild(documentsRoot, documentId)
  await mkdir(documentRoot, { recursive: true })
  const verifiedDocumentRoot = policy.resolveChild(documentsRoot, documentId)
  const destination = join(verifiedDocumentRoot, 'original.pdf')
  const partial = `${destination}.partial-${documentId}`
  await removeIfPresent(partial)
  await rejectExisting(destination)

  if (skipFirstPage) {
    // The rewritten bytes are what the document keeps, so they are what gets hashed and recorded.
    if (sourceInfo.size > MAX_PDF_CROP_BYTES) throw new CoreUtilityOperationError('CORE_PDF_REWRITE_FAILED', 'PDF is too large to rewrite', false)
    let published = false
    try {
      const rewritten = await withoutFirstPage(await readFile(sourcePath, { signal }))
      signal.throwIfAborted()
      const handle = await open(partial, 'wx')
      try {
        await handle.writeFile(rewritten)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(partial, destination)
      published = true
      return { sha256: createHash('sha256').update(rewritten).digest('hex'), size: rewritten.byteLength }
    } finally {
      if (!published) await removeIfPresent(partial)
    }
  }

  const hash = createHash('sha256')
  let size = 0
  let header = Buffer.alloc(0)
  let published = false
  try {
    const hashing = new Transform({
      transform(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (header.length < 1024) header = Buffer.concat([header, buffer.subarray(0, 1024 - header.length)])
        if (size > MAX_PDF_BYTES) {
          callback(new CoreUtilityOperationError('CORE_LIMIT_EXCEEDED', 'PDF exceeds the supported size limit', false))
          return
        }
        hash.update(buffer)
        callback(null, buffer)
      }
    })
    await pipeline(
      createReadStream(sourcePath),
      hashing,
      createWriteStream(partial, { flags: 'wx' }),
      { signal }
    )
    if (size === 0 || !/%PDF-\d\.\d/u.test(header.toString('latin1'))) {
      throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Invalid PDF header', false)
    }
    const handle = await open(partial, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(partial, destination)
    published = true
    return { sha256: hash.digest('hex'), size }
  } finally {
    if (!published) await removeIfPresent(partial)
  }
}

export async function rejectExisting(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
  throw new CoreUtilityOperationError('CORE_CONFLICT', 'PDF destination already exists', false)
}

export async function removeIfPresent(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined)
}
