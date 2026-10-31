import type { ModelProvider as PaperChatProvider, ProviderKey } from '../contract/models'
import type { ChatProvider } from './cloudProvider'
import type { CodexRuntime } from '@platform/codex/runtime/codexRuntime'
import type { CodexSettings } from '@platform/codex/contract/codex'
export type ModelInput = Omit<Parameters<ChatProvider['stream']>[0], 'provider' | 'key' | 'keys' | 'baseUrl'> & {
  provider: PaperChatProvider; keys?: readonly ProviderKey[]; baseUrl?: string; outputSchema?: unknown
  lane?: 'interactive' | 'background'
  effort?: NonNullable<CodexSettings['effort']>
}
export class ModelGateway {
  constructor(private readonly cloud: ChatProvider, private readonly codex: CodexRuntime) {}
  stream(input: ModelInput): ReturnType<ChatProvider['stream']> {
    if (input.provider === 'codex') return this.codex.generate(input)
    if (!input.keys?.length || !input.baseUrl) return Promise.reject(new Error('模型 API Key 未配置'))
    return this.cloud.stream({ ...input, provider: input.provider, keys: input.keys, baseUrl: input.baseUrl })
  }
}
