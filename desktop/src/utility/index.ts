import { parentPort } from 'electron'
import { createCoreUtilityRuntime } from './coreUtilityRuntime'

if (!parentPort) throw new Error('Core utility parent port is unavailable')

createCoreUtilityRuntime(parentPort)
