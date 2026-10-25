import type { IpcBridge } from '@platform/ipc/contract/channels'
import { createCodexApi } from '@platform/codex/contract/ipc'
import type { CodexApi } from '@platform/codex/contract/codex'
import { createPaperChatApi, type PaperChatDesktopApi } from '@features/chat/contract/ipc'
import { createFigureInsightApi, createPaperInsightApi, type FigureInsightDesktopApi, type PaperInsightDesktopApi } from '@features/insight/contract/ipc'
import { createLibraryApi, type LibraryDesktopApi } from '@features/library/contract/ipc'
import { createParsingApi, type ParsingDesktopApi } from '@features/parsing/contract/ipc'
import { createReaderApi, type ReaderDesktopApi } from '@features/reader/contract/ipc'
import { createSettingsApi, type SettingsDesktopApi } from '@features/settings/contract/ipc'
import { createTranslationApi, type TranslationDesktopApi } from '@features/translation/contract/ipc'
import { createZoteroApi } from '@features/zotero/contract/ipc'
import type { ZoteroDesktopApi } from '@features/zotero/contract/zotero'
import { createWindowApi, type WindowDesktopApi } from './window'

/** `window.copilotix`: the only privileged surface of the renderer, composed from each module's contract. */
export interface CopilotixDesktopApi
  extends LibraryDesktopApi, ParsingDesktopApi, TranslationDesktopApi, ReaderDesktopApi, SettingsDesktopApi, WindowDesktopApi {
  codex: CodexApi
  figureInsight: FigureInsightDesktopApi
  paperInsight: PaperInsightDesktopApi
  /** Read-only Zotero library browsing and import (see shared/zotero.ts). */
  zotero: ZoteroDesktopApi
  paperChat: PaperChatDesktopApi
}

export function createDesktopApi(ipc: IpcBridge, pathForFile: (file: File) => string): CopilotixDesktopApi {
  return {
    codex: createCodexApi(ipc),
    figureInsight: createFigureInsightApi(ipc),
    paperInsight: createPaperInsightApi(ipc),
    zotero: createZoteroApi(ipc),
    paperChat: createPaperChatApi(ipc),
    ...createLibraryApi(ipc, pathForFile),
    ...createParsingApi(ipc),
    ...createTranslationApi(ipc),
    ...createReaderApi(ipc),
    ...createSettingsApi(ipc),
    ...createWindowApi(ipc)
  }
}

declare global {
  interface Window {
    copilotix: CopilotixDesktopApi
  }
}
