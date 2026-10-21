import { useQuery } from '@tanstack/react-query'
import { DEFAULT_CODEX_SETTINGS } from '@shared/codex'
import { PAPER_CHAT_MODELS, resolvePaperChatModel, resolvePaperChatProvider } from '@shared/paperChatSchemas'
import { paperChatImageInput, paperChatImageUnsupportedMessage } from '@shared/paperChatFigures'
import type { AppSettings } from '@shared/types'
import type { PaperChatSession } from '@shared/paperChatStorageSchemas'
import { useCodexStatus } from './codexStatusClient'

/**
 * Provider, model and readiness derived from the shared translation settings. The chat panel
 * inspects Codex live; the reader's figure buttons only read the saved catalog, so opening a
 * paper never starts a Codex process.
 */
export function usePaperChatRouting(selected: PaperChatSession['selectedModel'], options: { inspect: boolean }) {
  const settingsQuery = useQuery<AppSettings>({ queryKey: ['settings'], queryFn: () => window.copilotix.getSettings() })
  const settings = settingsQuery.data
  const provider = settings ? resolvePaperChatProvider(settings, selected?.provider) : null
  const codexSettings = settings?.codex ?? DEFAULT_CODEX_SETTINGS
  const codexQuery = useQuery({ queryKey: ['codex', settings?.codex], queryFn: () => window.copilotix.codex.inspect({ settings: codexSettings }), enabled: options.inspect && provider === 'codex', staleTime: 60_000, retry: false })
  const savedCodexQuery = useQuery({ queryKey: ['codex-cached', settings?.codex], queryFn: () => window.copilotix.codex.cached(codexSettings), enabled: !options.inspect && provider === 'codex', staleTime: 60_000, retry: false })
  const liveCodex = useCodexStatus(codexSettings)
  const codex = options.inspect ? codexQuery.data : codexQuery.data ?? liveCodex ?? savedCodexQuery.data ?? undefined
  const configured = Boolean(settings && provider && (provider === 'codex' ? codex?.state === 'ready' : settings.credentials[provider].state === 'valid'))
  const defaultModel = provider === 'codex' ? settings?.codex?.chatModel ?? 'default' : provider === 'qwen' ? settings?.qwenChatModel ?? 'qwen-plus' : settings?.deepseekChatModel ?? 'deepseek-flash'
  const selectedModel = selected?.provider === provider ? selected.model : defaultModel
  const model = provider ? resolvePaperChatModel(provider, selectedModel) : ''
  const models = provider === 'codex' ? codex?.models.map(model => model.id) ?? [] : provider ? PAPER_CHAT_MODELS[provider] : []
  const validModel = Boolean(provider && models.includes(model))
  const imageInput = provider ? paperChatImageInput(provider, model, codex?.models) : false
  /** Why figures cannot be asked about now; null when the selected model accepts images. */
  const imageBlocked = !settings ? '正在读取问答设置' : !provider ? '请先在 Chat 中选择 Qwen、DeepSeek 或 Codex' : imageInput === true ? null : paperChatImageUnsupportedMessage(provider, model, imageInput)
  return { settings, provider, configured, model, models, validModel, imageInput, imageBlocked }
}

export type PaperChatRouting = ReturnType<typeof usePaperChatRouting>
