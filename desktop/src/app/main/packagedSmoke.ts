import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { forkUtilityProcess } from '@platform/rpc/main/electronUtilityFork'
import { resolveUtilityEntryPath } from '@platform/rpc/main/utilityEntryPath'
import { UtilitySupervisor } from '@platform/rpc/main/utilitySupervisor'
import { formatPackagedSmokeMarker } from '../contract/packagedSmoke'
import { coreProtocol, type CoreOperationRegistryShape } from '../contract/coreRpc'

/** Release check: start Utility against a throwaway database, ping it, print the marker and exit. */
export async function runPackagedSmoke(): Promise<void> {
  let smokeRoot: string | undefined
  let supervisor: UtilitySupervisor<CoreOperationRegistryShape> | undefined
  try {
    await app.whenReady()
    smokeRoot = await mkdtemp(join(app.getPath('temp'), 'copilotix-packaged-smoke-'))
    supervisor = new UtilitySupervisor({
      protocol: coreProtocol,
      entryPath: resolveUtilityEntryPath({
        isPackaged: app.isPackaged,
        bundleDirectory: __dirname,
        resourcesPath: process.resourcesPath
      }),
      fork: forkUtilityProcess,
      bootstrap: {
        databasePath: join(smokeRoot, 'smoke.sqlite3'),
        outputRoot: smokeRoot
      }
    })
    await supervisor.start()
    await supervisor.request('ping', {})
    const marker = formatPackagedSmokeMarker({
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? ''
    })
    await supervisor.shutdown()
    supervisor = undefined
    await rm(smokeRoot, { recursive: true, force: true })
    smokeRoot = undefined
    process.stdout.write(marker, 'utf8', (error) => app.exit(error ? 1 : 0))
  } catch {
    await supervisor?.shutdown().catch(() => undefined)
    if (smokeRoot) await rm(smokeRoot, { recursive: true, force: true }).catch(() => undefined)
    app.exit(1)
  }
}
