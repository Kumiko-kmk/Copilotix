import type { PaperChatProvider } from '@shared/paperChatSchemas'
import type { ChatProvider } from './chatProvider'
import type { CodexRuntime } from '@platform/codex/runtime/codexRuntime'
import type { CodexSettings } from '@platform/codex/contract/codex'
export type ModelInput = Omit<Parameters<ChatProvider['stream']>[0], 'provider' | 'key' | 'baseUrl'> & {
  provider: PaperChatProvider; key?: string | null; baseUrl?: string; outputSchema?: unknown
  lane?: 'interactive' | 'background'
  effort?: NonNullable<CodexSettings['effort']>
}
export class ModelGateway {
  constructor(private readonly cloud: ChatProvider, private readonly codex: CodexRuntime) {}
  stream(input: ModelInput): ReturnType<ChatProvider['stream']> {
    if (input.provider === 'codex') return this.codex.generate(input)
    if (!input.key || !input.baseUrl) return Promise.reject(new Error('模型 API Key 未配置'))
    return this.cloud.stream({ ...input, provider: input.provider, key: input.key, baseUrl: input.baseUrl })
  }
}
