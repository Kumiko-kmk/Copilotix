import { parentPort } from 'electron'
import { createCoreUtilityRuntime } from './coreUtilityRuntime'
import { createUtilityOperationHandlers } from './core/utilityOperations'

if (!parentPort) throw new Error('Core utility parent port is unavailable')

const persistence = createUtilityOperationHandlers()
createCoreUtilityRuntime(parentPort, {
  handlers: persistence.handlers,
  onDrain: persistence.flush,
  onShutdown: persistence.close
})
