import { app, dialog, utilityProcess, type UtilityProcess } from 'electron'
import { mkdtemp } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WindowsCredentialVault, type CredentialAccount } from '@platform/credentials/main/credentialVault'
import { resolveUtilityEntryPath } from '@platform/rpc/main/utilityEntryPath'

export const UNINSTALL_CLEANUP_ARG = '--copilotix-uninstall-cleanup'

interface CleanupPlan {
  userData: string
  libraryPaths: string[]
  documentCount: number
  token: string
}

/** Which installation's data this is; a separately installed edition never reaches another's. */
export interface UninstallIdentity {
  name: string
  userDataFolder: string
  credentialService: string
}

/** An explicit uninstall action: no renderer, queues, migrations or network. */
export async function runUninstallCleanup(identity: UninstallIdentity): Promise<void> {
  let child: UtilityProcess | undefined
  try {
    app.setName(identity.name)
    app.setPath('userData', join(app.getPath('appData'), identity.userDataFolder))
    if (!app.requestSingleInstanceLock()) {
      app.exit(2)
      return
    }
    // The lock has answered that no instance is running. Now this process must keep out of the folder
    // it may remove: Chromium would hold files there and rewrite others, and removal would always fail.
    app.releaseSingleInstanceLock()
    app.setPath('userData', await mkdtemp(join(app.getPath('temp'), 'copilotix-uninstall-cleanup-')))
    await app.whenReady()
    const entry = join(dirname(resolveUtilityEntryPath({
      isPackaged: app.isPackaged, bundleDirectory: __dirname, resourcesPath: process.resourcesPath
    })), 'uninstall-cleanup.js')
    child = utilityProcess.fork(entry, [], { serviceName: 'Copilotix uninstall cleanup', stdio: 'pipe' })
    const preview = request(child, {
      action: 'preview', options: {
        appData: app.getPath('appData'), installDirectory: dirname(process.execPath),
        protectedDirectories: ['home', 'documents', 'desktop', 'downloads', 'temp']
          .map((name) => app.getPath(name as 'home' | 'documents' | 'desktop' | 'downloads' | 'temp')),
        forbiddenDirectories: [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
          .filter((path): path is string => Boolean(path))
      }
    })
    const result = await preview
    const plan = result.plan as CleanupPlan
    if (!plan || typeof plan.userData !== 'string' || !Array.isArray(plan.libraryPaths) ||
        !Number.isSafeInteger(plan.documentCount) || typeof plan.token !== 'string') throw new Error('Invalid cleanup preview')
    const libraryRoots = [...new Set(plan.libraryPaths.map((path) => dirname(path)))]
    // Keep the native confirmation readable even for a large library.
    if (libraryRoots.length > 20) throw new Error('Too many distinct library locations')
    const english = process.argv.includes('--lang=1033')
    const confirmation = await dialog.showMessageBox({
      type: 'warning', title: english ? `Remove ${identity.name} data` : `清除 ${identity.name} 文庫與資料`,
      message: english ? `Permanently remove the following ${identity.name} data?` : `永久移除以下 ${identity.name} 文庫與資料？`,
      detail: (english
        ? `Application data: ${plan.userData}\nDocuments: ${plan.documentCount}\nLibrary folders:\n`
        : `應用資料：${plan.userData}\n文件數量：${plan.documentCount}\n文庫資料夾：\n`) +
        (libraryRoots.join('\n') || (english ? '(No registered document folders)' : '（沒有登記的文件資料夾）')) +
        (english ? '\n\nSettings, history, caches and saved API credentials will also be removed. Original source files, unrelated files in shared folders and external backups are preserved. This cannot be undone.'
          : '\n\n同時移除設定、歷史記錄、快取與已儲存的 API 憑證。原始來源檔案、共用資料夾中的其他檔案及外部備份會保留。此操作無法復原。'),
      buttons: english ? ['Cancel', 'Permanently remove'] : ['取消', '永久移除'],
      defaultId: 0, cancelId: 0, noLink: true
    })
    if (confirmation.response !== 1) {
      child.kill()
      app.exit(2)
      return
    }
    await request(child, { action: 'apply', token: plan.token })
    const vault = new WindowsCredentialVault(identity.credentialService)
    const accounts: CredentialAccount[] = ['parser-token', 'qwen-api-key', 'deepseek-api-key',
      'parser-token-validation', 'qwen-api-key-validation', 'deepseek-api-key-validation']
    const added = (await vault.accounts()).filter((account): account is CredentialAccount => account.startsWith('api-key:'))
    for (const account of new Set([...accounts, ...added])) await vault.delete(account)
    child.kill()
    app.exit(0)
  } catch {
    child?.kill()
    dialog.showErrorBox(identity.name, '無法完成資料清理，解除安裝已停止。資料庫可能損壞、路徑含連結，或檔案／憑證無法移除。已清理的專案不會復原；請保留程式並重試，或取消清除選項以保留其餘資料。')
    app.exit(1)
  }
}

function request(child: UtilityProcess, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (result: Record<string, unknown>): void => {
      cleanup()
      if (result?.ok !== true) reject(new Error('Cleanup worker failed'))
      else resolve(result)
    }
    const onExit = (): void => { cleanup(); reject(new Error('Cleanup worker exited')) }
    const cleanup = (): void => {
      child.removeListener('message', onMessage)
      child.removeListener('exit', onExit)
    }
    child.on('message', onMessage)
    child.once('exit', onExit)
    child.postMessage(message)
  })
}
