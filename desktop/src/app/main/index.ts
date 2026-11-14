import { join } from 'node:path'
import { app, dialog, protocol } from 'electron'
import { runUninstallCleanup, UNINSTALL_CLEANUP_ARG } from '@platform/uninstall/main/uninstallCleanup'
import { shouldRunPackagedSmoke } from '../contract/packagedSmoke'
import { bootstrap } from './bootstrap'
import { APP_IDENTITY } from './identity'
import { runPackagedSmoke } from './packagedSmoke'
import { appShell, libraryGate, services, startup } from './services'
import { acquirePrimaryInstance } from './singleInstance'

// Composition root of the Main process: lifecycle only. Services and IPC are
// assembled in ./bootstrap from each module's main entry.
const packagedSmokeMode = shouldRunPackagedSmoke(process.argv, app.isPackaged)

if (app.isPackaged && process.argv.includes(UNINSTALL_CLEANUP_ARG)) {
  void runUninstallCleanup({ name: APP_IDENTITY.productName, userDataFolder: APP_IDENTITY.userDataFolder, credentialService: APP_IDENTITY.credentialService })
} else if (packagedSmokeMode) {
  void runPackagedSmoke()
} else {
  startNormalApp()
}

function startupErrorCode(error: unknown): 'CORE_TIMEOUT' | 'CORE_UNAVAILABLE' | 'CORE_PROTOCOL_ERROR' {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  return code === 'CORE_TIMEOUT' || code === 'CORE_PROTOCOL_ERROR' || code === 'CORE_UNAVAILABLE'
    ? code
    : 'CORE_UNAVAILABLE'
}

function startNormalApp(): void {
  // The product ships only Traditional Chinese resources, regardless of OS locale.
  app.commandLine.appendSwitch('lang', 'zh-TW')
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'copilotix-asset',
      privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])

  app.setName(APP_IDENTITY.productName)
  const isolatedUserData = process.env.NODE_ENV === 'test' ? process.env.COPILOTIX_E2E_USER_DATA : undefined
  app.setPath('userData', isolatedUserData || join(app.getPath('appData'), APP_IDENTITY.userDataFolder))
  if (!acquirePrimaryInstance(app, () => appShell.mainWindow)) return

  app.on('before-quit', (event) => {
    if (libraryGate.busy) { event.preventDefault(); return }
    appShell.isQuitting = true
    const utility = services.utility
    if (!utility || utility.isStopped() || services.utilityShutdown) return
    event.preventDefault()
    services.utilityShutdown = Promise.all([services.paperChat?.settle(), services.paperInsight?.dispose(), services.figureInsight?.dispose()]).then(() => services.scheduler?.shutdown()).catch(() => undefined).then(() => { services.codex?.close(); return utility.shutdown() }).catch(() => undefined).then(() => {
      app.quit()
    })
  })

  app.on('window-all-closed', () => {
    services.paperChat?.dispose()
    // Keep the background queue alive in the tray on Windows.
  })

  void bootstrap().catch((error: unknown) => {
    // Keep startup diagnostics free of stack traces, local paths and credentials.
    const code = startupErrorCode(error)
    console.error(`Copilotix startup failed [${code}] phase=${startup.phase}`)
    if (process.env.COPILOTIX_STARTUP_DIAGNOSTICS === 'true') {
      console.error(error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error))
    }
    // Playwright and other headless checks must not wait on a native modal.
    if (process.env.NODE_ENV !== 'test') {
      const message = (startup.phase === 'core-start' || startup.phase === 'repository-init')
        ? '核心服務或文件資料庫無法初始化。請勿刪除原資料庫或使用更舊版本反覆嘗試。升級前快照（如已生成）儲存在下方目錄，名稱含 pre-migration；恢復方法見文件庫管理指南。\n\n' + app.getPath('userData')
        : '核心服務無法啟動，請重試。'
      dialog.showErrorBox(`${APP_IDENTITY.productName} 啟動失敗`, message)
    }
    app.quit()
  })
}
