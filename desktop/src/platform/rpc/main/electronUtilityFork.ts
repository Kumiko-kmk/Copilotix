import { utilityProcess } from 'electron'
import type { UtilityFork, UtilityProcessLike } from './utilitySupervisor'

/** Main-only adapter; the supervisor itself stays importable in non-Electron tests. */
export const forkUtilityProcess: UtilityFork = (entryPath, args, options): UtilityProcessLike =>
  utilityProcess.fork(entryPath, args, options) as unknown as UtilityProcessLike
