import { z } from 'zod'
import { documentTimestamp, noNul, uuid } from '@platform/ipc/contract/validation'

/** IPC schemas for reader annotations and cached figures. */

export const cacheDocumentFigureRequestSchema = z.object({
  documentId: uuid,
  figureId: z.string().min(1).max(512),
  geometryKey: z.string().min(1).max(512),
  sourceRevision: z.string().length(64).optional(),
  pngBase64: z.string().min(1).max(46 * 1024 * 1024).optional()
}).strict()

export type CacheDocumentFigureRequest = z.infer<typeof cacheDocumentFigureRequestSchema>
export const cacheDocumentFigureResultSchema = z.object({ imagePath: z.string().nullable(), sourceRevision: z.string().length(64) }).strict()
export type CacheDocumentFigureResult = z.infer<typeof cacheDocumentFigureResultSchema>
export const documentAnnotationViewSchema = z.enum(['original', 'translated'])
export const documentAnnotationKindSchema = z.enum(['highlight', 'underline'])
export const documentHighlightColorSchema = z.enum(['yellow', 'green', 'blue', 'pink', 'purple'])

export const documentAnnotationSchema = z.object({
  id: uuid,
  documentId: uuid,
  artifactId: uuid,
  view: documentAnnotationViewSchema,
  kind: documentAnnotationKindSchema,
  color: documentHighlightColorSchema.nullable(),
  blockKey: z.string().min(1).max(4_096).refine(noNul, '区块键不能包含 NUL 字符'),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(1),
  quote: z.string().min(1).max(1_000_000).refine(noNul, '引用不能包含 NUL 字符'),
  prefix: z.string().max(256).refine(noNul, '前缀不能包含 NUL 字符'),
  suffix: z.string().max(256).refine(noNul, '后缀不能包含 NUL 字符'),
  createdAt: documentTimestamp,
  updatedAt: documentTimestamp
}).strict().superRefine((value, context) => {
  if (value.endOffset <= value.startOffset) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['endOffset'], message: '结束偏移必须大于起始偏移' })
  }
  if (value.quote.length !== value.endOffset - value.startOffset) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['quote'], message: '引用长度必须匹配偏移范围' })
  }
  if (value.kind === 'underline' && value.color !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['color'], message: '下划线标注不能设置颜色' })
  }
})

export type DocumentAnnotation = z.infer<typeof documentAnnotationSchema>

export const listReaderAnnotationsRequestSchema = z.object({
  documentId: uuid,
  view: documentAnnotationViewSchema
}).strict()

export type ListReaderAnnotationsRequest = z.infer<typeof listReaderAnnotationsRequestSchema>

export const readerAnnotationSnapshotSchema = z.object({
  documentId: uuid,
  artifactId: uuid,
  view: documentAnnotationViewSchema,
  revision: z.number().int().min(0),
  annotations: z.array(documentAnnotationSchema).max(50_000)
}).strict()

export type ReaderAnnotationSnapshot = z.infer<typeof readerAnnotationSnapshotSchema>

export const mutateReaderAnnotationsRequestSchema = z.object({
  documentId: uuid,
  artifactId: uuid,
  view: documentAnnotationViewSchema,
  expectedRevision: z.number().int().min(0),
  upserts: z.array(documentAnnotationSchema).max(50_000),
  deleteIds: z.array(uuid).max(50_000)
}).strict().superRefine((value, context) => {
  const upsertIds = new Set(value.upserts.map((annotation) => annotation.id))
  const deleteIds = new Set(value.deleteIds)
  if (upsertIds.size !== value.upserts.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['upserts'], message: 'upserts 标注 ID 必须唯一' })
  }
  if (deleteIds.size !== value.deleteIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['deleteIds'], message: 'deleteIds 必须唯一' })
  }
  for (const id of upsertIds) {
    if (deleteIds.has(id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['deleteIds'], message: 'upsert 和 delete 不能包含同一标注' })
      break
    }
  }
  for (const [index, annotation] of value.upserts.entries()) {
    if (annotation.documentId !== value.documentId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['upserts', index, 'documentId'], message: '标注文档不匹配' })
    }
    if (annotation.artifactId !== value.artifactId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['upserts', index, 'artifactId'], message: '标注产物不匹配' })
    }
    if (annotation.view !== value.view) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['upserts', index, 'view'], message: '标注视图不匹配' })
    }
  }
})

export type MutateReaderAnnotationsRequest = z.infer<typeof mutateReaderAnnotationsRequestSchema>
