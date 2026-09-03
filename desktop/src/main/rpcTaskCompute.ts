import type { MinerUTask } from '@shared/types'
import type { UtilitySupervisor } from './utilitySupervisor'
import type { TaskComputePort } from '@core/ports'

/** Main-side compute proxy; all heavy file/hash/mapping work remains utility-owned. */
export class RpcTaskCompute implements TaskComputePort {
  constructor(private readonly supervisor: UtilitySupervisor) {}

  async hashFile(path: string): Promise<string> {
    const result = await this.supervisor.request('compute:hash-file', { path })
    return result.sha256
  }

  async normalizeParserOutput(task: MinerUTask, extractedDir: string): Promise<void> {
    await this.supervisor.request('compute:normalize-parser', { task, extractedDir })
  }

  async rebuildMappings(taskId: string, outputDir: string): Promise<void> {
    await this.supervisor.request('compute:rebuild-mappings', { taskId, outputDir })
  }
}
