import { z } from 'zod'

/** Figures attached to one question. Each image travels to the model in full, so keep this small. */
export const PAPER_CHAT_MAX_FIGURES = 4
/** Panels sent for a figure without a verified whole-figure crop. */
export const PAPER_CHAT_MAX_FIGURE_IMAGES = 6
export const PAPER_CHAT_MAX_IMAGE_BYTES = 14 * 1024 * 1024
/** All encoded images of one request; below the 20 MiB request ceilings of the providers. */
export const PAPER_CHAT_MAX_IMAGE_TOTAL_BYTES = 18 * 1024 * 1024

// Control characters are what this check rejects.
// eslint-disable-next-line no-control-regex
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value))
export const paperChatFigureIdSchema = z.string().min(1).max(256).regex(/^[\w:.-]+$/u)
const mappingIdSchema = z.string().min(1).max(256)
const evidenceIdSchema = z.string().regex(/^E[1-9]\d{0,3}$/u)
/** Relative to the paper directory: a whole-figure crop or a parsed panel image. */
export const paperChatFigureImagePathSchema = z.string().regex(/^images\/(?:figures\/figure-p\d+-[a-f0-9]{24}\.png|[A-Za-z0-9_-]{1,128}\.(?:jpe?g|png))$/iu)

/** What the reader attaches. Main resolves the image and context from the paper's own files. */
export const paperChatFigurePinSchema = z.object({
  figureId: paperChatFigureIdSchema,
  label: text(64).nullable(),
  pageIndex: z.number().int().min(0).max(100_000).nullable(),
  /** A parsed panel shown as the composer thumbnail; display only. */
  preview: paperChatFigureImagePathSchema.optional()
}).strict()
export type PaperChatFigurePin = z.infer<typeof paperChatFigurePinSchema>

/** Kept with the turn: references only, never image bytes. */
export const paperChatTurnFigureSchema = paperChatFigurePinSchema.extend({
  images: z.array(z.object({ path: paperChatFigureImagePathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()).min(1).max(PAPER_CHAT_MAX_FIGURE_IMAGES)
}).strict()
export type PaperChatTurnFigure = z.infer<typeof paperChatTurnFigureSchema>

export const paperChatFigureRequestSchema = z.object({ documentId: z.string().uuid(), figureId: paperChatFigureIdSchema }).strict()
export type PaperChatFigureRequest = z.infer<typeof paperChatFigureRequestSchema>
/** Utility-resolved figure. Paths are checked by PathPolicy; Main re-reads and re-hashes the bytes. */
export const paperChatFigureSourceSchema = paperChatFigureRequestSchema.extend({
  label: text(64).nullable(),
  /** Mention key from figureMentions.ts, e.g. "1" or "supplementary:S2"; null without a caption label. */
  key: z.string().min(1).max(64).nullable(),
  pageIndex: z.number().int().min(0).max(100_000),
  caption: z.string().max(8000),
  captionMappingIds: z.array(mappingIdSchema).max(64),
  mappingIds: z.array(mappingIdSchema).max(512),
  /** True for the verified whole-figure crop; false when only parsed panels are available. */
  whole: z.boolean(),
  images: z.array(z.object({
    path: paperChatFigureImagePathSchema,
    absolutePath: z.string().min(1).max(8192),
    bytes: z.number().int().positive().max(PAPER_CHAT_MAX_IMAGE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    mimeType: z.enum(['image/png', 'image/jpeg'])
  }).strict()).min(1).max(PAPER_CHAT_MAX_FIGURE_IMAGES)
}).strict()
export type PaperChatFigureSource = z.infer<typeof paperChatFigureSourceSchema>

/** Context-builder input: which chunks belong to the figure and how the text refers to it. */
export const paperContextFigureSchema = z.object({
  figureId: paperChatFigureIdSchema,
  key: z.string().min(1).max(64).nullable(),
  captionMappingIds: z.array(mappingIdSchema).max(64),
  mappingIds: z.array(mappingIdSchema).max(512)
}).strict()
export const paperContextFigureResultSchema = z.object({
  figureId: paperChatFigureIdSchema,
  sectionPath: z.array(z.string().max(512)).max(16),
  captionEvidenceIds: z.array(evidenceIdSchema).max(32),
  mentionEvidenceIds: z.array(evidenceIdSchema).max(64),
  nearbyEvidenceIds: z.array(evidenceIdSchema).max(128),
  /** Mentions found in the paper but left out by the context budget. */
  omittedMentions: z.number().int().min(0).max(100_000)
}).strict()
export type PaperContextFigure = z.infer<typeof paperContextFigureSchema>
export type PaperContextFigureResult = z.infer<typeof paperContextFigureResultSchema>

/**
 * Image input per chat model. Qwen-plus and DeepSeek Pro are text-only (docs/FIGURE_INSIGHT_ZH.md);
 * Codex reports image support per model in its catalog. null: Codex catalog unknown, refresh first.
 */
export const PAPER_CHAT_IMAGE_MODELS = { qwen: ['qwen3.8-flash', 'qwen3.8-max'], deepseek: ['deepseek-flash'] } as const
export function paperChatImageInput(provider: 'qwen' | 'deepseek' | 'codex', model: string, codexModels?: ReadonlyArray<{ id: string; image: boolean }> | null): boolean | null {
  if (provider !== 'codex') return (PAPER_CHAT_IMAGE_MODELS[provider] as readonly string[]).includes(model)
  const entry = codexModels?.find(item => item.id === model)
  return entry ? entry.image : null
}
export function paperChatImageUnsupportedMessage(provider: 'qwen' | 'deepseek' | 'codex', model: string, support: boolean | null): string {
  if (support === null) return `无法确认 Codex 模型 ${model} 是否支持图片，请在「服务连接」中刷新 Codex 后重试`
  const alternatives = provider === 'codex' ? '支持图片的 Codex 模型' : PAPER_CHAT_IMAGE_MODELS[provider].join('、')
  return `当前问答模型 ${model} 不支持图片输入，请在问答中切换到 ${alternatives}`
}
