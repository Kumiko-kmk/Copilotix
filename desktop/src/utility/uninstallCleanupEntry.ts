import { executeUninstallCleanup, prepareUninstallCleanup, type UninstallCleanupOptions, type UninstallCleanupPlan } from './uninstallCleanup'

const port = process.parentPort
if (!port) throw new Error('Uninstall utility parent port is unavailable')
let plan: UninstallCleanupPlan | undefined
let busy = false
port.on('message', async (event) => {
  if (busy) { port.postMessage({ ok: false, error: 'Cleanup is already running.' }); return }
  busy = true
  try {
    const message = event.data as { action?: string; options?: UninstallCleanupOptions; token?: string }
    if (message.action === 'preview' && message.options && !plan) {
      plan = await prepareUninstallCleanup(message.options)
      port.postMessage({ ok: true, plan })
    } else if (message.action === 'apply' && plan && message.token === plan.token) {
      await executeUninstallCleanup(plan)
      port.postMessage({ ok: true, done: true })
    } else throw new Error('Invalid uninstall operation')
  } catch {
    port.postMessage({ ok: false, error: 'Unable to safely remove application data. Check the library paths and try again.' })
  } finally { busy = false }
})
