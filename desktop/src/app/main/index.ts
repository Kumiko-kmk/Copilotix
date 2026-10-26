import { join } from 'node:path'
import { app, dialog, protocol } from 'electron'
import { runUninstallCleanup, UNINSTALL_CLEANUP_ARG } from '@platform/uninstall/main/uninstallCleanup'
import { shouldRunPackagedSmoke } from '../contract/packagedSmoke'
import { bootstrap } from './bootstrap'
import { runPackagedSmoke } from './packagedSmoke'
import { appShell, libraryGate, services, startup } from './services'
import { acquirePrimaryInstance } from './singleInstance'

// Composition root of the Main process: lifecycle only. Services and IPC are
// assembled in ./bootstrap from each module's main entry.
const packagedSmokeMode = shouldRunPackagedSmoke(process.argv, app.isPackaged)

if (app.isPackaged && process.argv.includes(UNINSTALL_CLEANUP_ARG)) {
  void runUninstallCleanup()
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
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'copilotix-asset',
      privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])

  app.setName('Copilotix')
  const isolatedUserData = process.env.NODE_ENV === 'test' ? process.env.COPILOTIX_E2E_USER_DATA : undefined
  app.setPath('userData', isolatedUserData || join(app.getPath('appData'), 'Copilotix-Translation-v2'))
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
        ? '核心服务或文档数据库无法初始化。请勿删除原数据库或使用更旧版本反复尝试。升级前快照（如已生成）保存在下方目录，名称含 pre-migration；恢复方法见文档库管理指南。\n\n' + app.getPath('userData')
        : '核心服务无法启动，请重试。'
      dialog.showErrorBox('Copilotix 启动失败', message)
    }
    app.quit()
  })
}
