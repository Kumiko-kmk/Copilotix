import { createCoreUtilityRuntime } from '@platform/rpc/utility/coreUtilityRuntime'
import { createUtilityOperationHandlers } from '../../utility/core/utilityOperations'
import { coreProtocol, type CoreOperationRegistryShape } from '../contract/coreRpc'

// Electron exposes the utility IPC endpoint on the child process object.  The
// cross-process `electron` module does not expose `parentPort` in this context.
const parentPort = process.parentPort

if (!parentPort) throw new Error('Core utility parent port is unavailable')

const persistence = createUtilityOperationHandlers()
createCoreUtilityRuntime<CoreOperationRegistryShape>(parentPort, {
  protocol: coreProtocol,
  handlers: persistence.handlers,
  onDrain: persistence.flush,
  onShutdown: persistence.close
})
