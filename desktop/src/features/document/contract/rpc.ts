import { z } from 'zod'
import { coreIdSchema } from '@platform/rpc/contract/protocol'
export const documentModelRequest = z.object({ documentId: coreIdSchema }).strict()
export const documentModelDescriptor = z.object({ documentId: coreIdSchema, sourceVersion: z.string().regex(/^[a-f0-9]{64}$/u), path: z.literal('model/base.v1.json'), digest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
export const documentOperations = { 'compute:document-model': { payload: documentModelRequest, result: documentModelDescriptor } } as const
export type DocumentOperations = typeof documentOperations
