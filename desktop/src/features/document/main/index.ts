import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { PathPolicyPort } from '@platform/files/contract/pathPolicyPort'
import type { DocumentBase, DocumentModelDescriptor } from '../contract/documentModel'
export async function readDocumentModel(root: string, descriptor: DocumentModelDescriptor, policy: PathPolicyPort): Promise<DocumentBase> {
  const value = JSON.parse(await readFile(policy.resolveChild(root, descriptor.path), 'utf8')) as { base: DocumentBase; digest: string }
  if (value.digest !== descriptor.digest || value.base.documentId !== descriptor.documentId || value.base.sourceVersion !== descriptor.sourceVersion || createHash('sha256').update(JSON.stringify(value.base)).digest('hex') !== descriptor.digest) throw new Error('文档模型已变化，请重新读取')
  return value.base
}
