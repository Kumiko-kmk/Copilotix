import { z } from 'zod'

export const libraryRequestSchema = z.object({ action: z.enum(['backup', 'restore', 'migrate']) }).strict()
export const libraryResultSchema = z.object({
  status: z.enum(['cancelled', 'completed']),
  path: z.string().max(32768).optional(),
  restartRequired: z.boolean()
}).strict()
export const libraryCoreRequestSchema = libraryRequestSchema.extend({
  path: z.string().min(1).max(32768).refine((value) => !value.includes('\0'))
}).strict()
export type LibraryRequest = z.infer<typeof libraryRequestSchema>
export type LibraryResult = z.infer<typeof libraryResultSchema>
