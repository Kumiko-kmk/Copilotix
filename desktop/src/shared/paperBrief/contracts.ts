import { z } from 'zod'
import { paperBriefSchema } from './schema'

export const PAPER_BRIEF_MAX_BYTES = 256 * 1024
const text = (max: number) => z.string().trim().min(1).max(max)
const role = z.enum(['front', 'abstract', 'introduction', 'background', 'method', 'results', 'discussion', 'limitations', 'conclusion', 'body', 'caption'])
export const briefAnchorSchema = z.object({ id: z.string().regex(/^E\d{1,3}$/u), section: text(4096), text: text(4096) }).strict()
export const briefAnchorsSchema = z.array(briefAnchorSchema).max(96)
export type BriefAnchor = z.infer<typeof briefAnchorSchema>
export const briefContextResultSchema = z.object({
  documentId: z.uuid(), sourceRevision: text(512),
  context: z.object({
    title: text(4096).nullable(), language: z.enum(['original', 'translated']), outline: z.array(text(4096)).max(200),
    excerpts: z.array(briefAnchorSchema.extend({ role })).min(1).max(96),
    coverage: z.object({ roles: z.array(role), missingRoles: z.array(role), sourceBytes: z.number().int().nonnegative(), sentBytes: z.number().int().nonnegative(), truncated: z.boolean() }).strict()
  }).strict()
}).strict()
export type BriefContextResult = z.infer<typeof briefContextResultSchema>
export const paperBriefSaveSchema = z.object({ documentId: z.uuid(), brief: paperBriefSchema, anchors: briefAnchorsSchema }).strict()
export const paperBriefRecordSchema = paperBriefSaveSchema.extend({ version: z.literal(2) })
