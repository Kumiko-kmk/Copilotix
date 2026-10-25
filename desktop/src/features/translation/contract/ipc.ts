import { invokeChannel, type IpcBridge } from '@platform/ipc/contract/channels'
import { voidResponseSchema } from '@platform/ipc/contract/schemas'
import { documentIdRequestSchema } from '@shared/ipcSchemas'

export const translationChannels = {
  retranslateEdited: invokeChannel('documents:retranslate-edited', documentIdRequestSchema, voidResponseSchema)
}

export interface TranslationDesktopApi {
  /** Retranslates after original text was edited; unchanged blocks come from the translation cache. */
  retranslateEditedDocument(documentId: string): Promise<void>
}

export function createTranslationApi(ipc: IpcBridge): TranslationDesktopApi {
  return {
    retranslateEditedDocument: documentId => ipc.invoke(translationChannels.retranslateEdited, documentId)
  }
}
