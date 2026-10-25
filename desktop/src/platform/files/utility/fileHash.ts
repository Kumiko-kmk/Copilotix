import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { isAbsolute } from 'node:path'
import { CoreUtilityOperationError } from '@platform/rpc/utility/coreUtilityRuntime'

/** File helpers shared by Utility operations (import, parsing, maintenance). */

export async function hashFile(path: string): Promise<string> {
  if (!isAbsolute(path) || path.length > 32_768 || path.includes('\0')) throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Invalid compute path', false)
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const input = createReadStream(path)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', resolvePromise)
    input.on('error', reject)
  })
  return hash.digest('hex')
}

export function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT')
}
