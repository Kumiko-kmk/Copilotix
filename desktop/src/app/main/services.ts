import type { CodexRuntime } from '@platform/codex/runtime/codexRuntime'
import type { JobScheduler } from '@platform/jobs/main/jobScheduler'
import type { UtilitySupervisor } from '@platform/rpc/main/utilitySupervisor'
import type { FigureInsightService, PaperInsightService } from '@features/insight/main'
import type { PaperChatService } from '@features/chat/main'
import { LibraryAccessGate } from '@main/libraryAccessGate'
import type { CoreOperationRegistryShape } from '../contract/coreRpc'
import { AppShell } from './window'

/**
 * Long-lived services the app lifecycle (quit, window close) must reach. Each is
 * set as soon as bootstrap creates it, so a quit during startup sees only what exists.
 */
export const services: {
  utility: UtilitySupervisor<CoreOperationRegistryShape> | null
  utilityShutdown: Promise<void> | null
  codex: CodexRuntime | null
  paperChat: PaperChatService | null
  paperInsight: PaperInsightService | null
  figureInsight: FigureInsightService | null
  scheduler: JobScheduler | null
} = {
  utility: null,
  utilityShutdown: null,
  codex: null,
  paperChat: null,
  paperInsight: null,
  figureInsight: null,
  scheduler: null
}

export const libraryGate = new LibraryAccessGate()

/** Main is bundled into one file, so this is the bundle directory (out/main). */
export const appShell = new AppShell(__dirname)

/** Last startup step reached; reported without details when startup fails. */
export const startup = { phase: 'module-load' }
