import { paperInsightRequestSchema, paperInsightStateSchema, paperInsightCancelSchema } from '@shared/paperInsight'
import { voidResponseSchema } from '@shared/ipcSchemas'
import { registerValidatedHandler, type IpcValidationOptions } from '../ipc'
import type { PaperInsightService } from './paperInsightService'

export function registerPaperInsightHandlers(service: PaperInsightService, options: IpcValidationOptions): void {
  registerValidatedHandler('paperInsight:get', paperInsightRequestSchema, paperInsightStateSchema, (_event, request) => service.get(request.documentId), options)
  registerValidatedHandler('paperInsight:generate', paperInsightRequestSchema, voidResponseSchema, (_event, request) => service.generate(request.documentId), options)
  registerValidatedHandler('paperInsight:cancel', paperInsightRequestSchema, paperInsightCancelSchema, (_event, request) => service.cancel(request.documentId), options)
}
