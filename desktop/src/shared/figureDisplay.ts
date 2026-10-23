import { z } from 'zod'

/**
 * Per-figure display choice in the reader: the PDF crop or the parsed panel images. Stored in
 * `<document>/reader/figure-display.v1.json` (no migration; older builds ignore the folder) and
 * keyed by the figure's geometry ID, which is stable for a given parse.
 */
export const FIGURE_DISPLAY_MAX = 2_000

export const figureDisplayChoiceSchema = z.enum(['pdf', 'parsed'])
const figureIdSchema = z.string().regex(/^reader-figure-\d+-[\w:.-]{1,240}$/u)

export const figureDisplayRequestSchema = z.object({ documentId: z.string().uuid() }).strict()
export const figureDisplayChoicesSchema = z.object({
  choices: z.record(figureIdSchema, figureDisplayChoiceSchema)
}).strict().refine((value) => Object.keys(value.choices).length <= FIGURE_DISPLAY_MAX, 'Too many figure choices')
export const figureDisplaySetRequestSchema = figureDisplayRequestSchema.extend({
  figureId: figureIdSchema,
  /** null returns the figure to the automatic choice. */
  choice: figureDisplayChoiceSchema.nullable()
}).strict()
export const figureDisplayFileSchema = z.object({
  version: z.literal(1),
  choices: z.record(figureIdSchema, figureDisplayChoiceSchema)
}).strict()

export type FigureDisplayChoice = z.infer<typeof figureDisplayChoiceSchema>
export type FigureDisplayChoices = z.infer<typeof figureDisplayChoicesSchema>
export type FigureDisplaySetRequest = z.infer<typeof figureDisplaySetRequestSchema>

export interface FigureDisplayDesktopApi {
  get(request: { documentId: string }): Promise<FigureDisplayChoices>
  set(request: FigureDisplaySetRequest): Promise<FigureDisplayChoices>
}
