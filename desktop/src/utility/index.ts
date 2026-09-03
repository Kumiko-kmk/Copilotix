import { createCoreUtilityRuntime } from './coreUtilityRuntime'
import { createUtilityOperationHandlers } from './core/utilityOperations'

// Electron exposes the utility IPC endpoint on the child process object.  The
// cross-process `electron` module does not expose `parentPort` in this context.
const parentPort = process.parentPort

if (!parentPort) throw new Error('Core utility parent port is unavailable')

const persistence = createUtilityOperationHandlers()
createCoreUtilityRuntime(parentPort, {
  handlers: persistence.handlers,
  onDrain: persistence.flush,
  onShutdown: persistence.close
})
