import { figureInsightRequestSchema, figureInsightStateSchema, figureInsightCancelSchema } from '@shared/figureInsight'
import { voidResponseSchema } from '@shared/ipcSchemas'
import { registerValidatedHandler, type IpcValidationOptions } from '../ipc'
import type { FigureInsightService } from './figureInsightService'

export function registerFigureInsightHandlers(service: FigureInsightService, options: IpcValidationOptions): void {
  registerValidatedHandler('figureInsight:get', figureInsightRequestSchema, figureInsightStateSchema, (_event, request) => service.get(request), options)
  registerValidatedHandler('figureInsight:generate', figureInsightRequestSchema, voidResponseSchema, (_event, request) => service.generate(request), options)
  registerValidatedHandler('figureInsight:cancel', figureInsightRequestSchema, figureInsightCancelSchema, (_event, request) => service.cancel(request), options)
}
