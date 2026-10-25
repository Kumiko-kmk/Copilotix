import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app, dialog, shell, type BrowserWindow } from 'electron'
import type { IpcRegistrar } from '@platform/ipc/main/ipc'
import type { JobScheduler } from '@platform/jobs/main/jobScheduler'
import type { LibraryCategoriesPage, LibraryCategoriesRequest } from '@shared/libraryCategories'
import type { LibraryCoreRequest, LibraryResult } from '@shared/librarySchemas'
import { projectDocumentSummary } from '@shared/documentSummary'
import { sanitizeTitleStem } from '@shared/titleNaming'
import { TUTORIAL_PAPER_BYTES, TUTORIAL_PAPER_SHA256 } from '@shared/tutorialSample'
import { projectDocumentDetails } from '@main/documentProjection'
import type { LibraryAccessGate } from '@main/libraryAccessGate'
import type { TaskRepositoryCompat } from '@main/taskRepositoryCompat'
import type { TaskService } from '@main/taskService'
import { verifiedTutorialPaperPath } from '@main/tutorialSample'
import { libraryChannels } from '../contract/ipc'
import type { DocumentFeed } from './documentFeed'

export interface LibraryIpcDeps {
  tasks: TaskService
  repository: TaskRepositoryCompat
  feed: DocumentFeed
  gate: LibraryAccessGate
  scheduler: JobScheduler
  mainWindow(): BrowserWindow
  /** Directory of the Main bundle; locates the bundled tutorial paper in development. */
  bundleDirectory: string
  utility: {
    categories(request: LibraryCategoriesRequest): Promise<LibraryCategoriesPage>
    check(): Promise<unknown>
    manage(request: LibraryCoreRequest): Promise<LibraryResult>
  }
  /** Background work that must stop before the library is backed up, restored or moved. */
  maintenance: {
    pause(): Promise<void>
    settle(): Promise<void>
    resume(): void
  }
  /** Cancels the document's chat and insight work before its files are deleted. */
  deleteDocument(documentId: string, deleteFiles: boolean): Promise<void>
}

export function registerLibraryIpc(ipc: IpcRegistrar, deps: LibraryIpcDeps): void {
  const { tasks, repository } = deps
  ipc.handle(libraryChannels.categories, (_event, request) => deps.utility.categories(request))
  ipc.handle(libraryChannels.manage, async (_event, request) => {
    const title = request.action === 'backup' ? '选择备份保存目录' : request.action === 'restore' ? '选择包含 manifest.json 的备份目录' : '选择空目录迁移文档库'
    const selected = await dialog.showOpenDialog(deps.mainWindow(), { title, properties: ['openDirectory', 'createDirectory'] })
    if (selected.canceled || !selected.filePaths[0]) return { status: 'cancelled' as const, restartRequired: false }
    if (request.action !== 'backup') {
      const confirmation = await dialog.showMessageBox(deps.mainWindow(), {
        type: 'warning', title,
        message: request.action === 'restore' ? '用所选备份替换当前文档库？' : '将全部文档迁移到所选目录？',
        detail: request.action === 'restore'
          ? '恢复前会完整备份当前文档库。现有文件会保留，API 密钥不变；完成后自动重启。仅支持相同数据库版本的备份。'
          : '全部文档复制并校验成功后才切换位置，原文件保留。完成后自动重启。',
        buttons: ['取消', '继续'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (confirmation.response !== 1) return { status: 'cancelled' as const, restartRequired: false }
    }
    await deps.utility.check()
    await deps.maintenance.pause()
    try {
      await deps.maintenance.settle()
      await deps.scheduler.shutdown()
      const result = await deps.utility.manage({ ...request, path: selected.filePaths[0] })
      if (result.restartRequired) {
        deps.gate.requireRestart()
        setTimeout(() => { app.relaunch(); app.quit() }, 1200)
      }
      return result
    } finally {
      if (!deps.gate.restarting) { await deps.scheduler.start(); deps.maintenance.resume() }
    }
  })
  ipc.handle(libraryChannels.importDocuments, async (_event, request) => {
    let paths = request.paths
    if (paths === undefined) {
      const result = await dialog.showOpenDialog(deps.mainWindow(), {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (result.canceled) return { created: [], failed: [] }
      paths = result.filePaths
    }
    const selected = paths
      .map((path, index) => ({ path, file: request.files?.[index] ?? {} }))
      .filter(({ path }) => path.toLowerCase().endsWith('.pdf'))
    const imported = await tasks.importPaths(selected.map(({ path }) => path), request.options, selected.map(({ file }) => file))
    return { created: imported.created.map(projectDocumentSummary), failed: imported.failed }
  })
  ipc.handle(libraryChannels.importTutorialPaper, async (_event, request) => {
    const samplePath = await verifiedTutorialPaperPath({
      isPackaged: app.isPackaged,
      bundleDirectory: deps.bundleDirectory,
      resourcesPath: process.resourcesPath
    })
    const selection = await dialog.showOpenDialog(deps.mainWindow(), {
      defaultPath: samplePath,
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (selection.canceled || !selection.filePaths[0]) return null
    const selectedPath = selection.filePaths[0]
    if ((await stat(selectedPath)).size !== TUTORIAL_PAPER_BYTES) throw new Error('新手教程请选择窗口中预选的内置论文 Attention Is All You Need')
    const selectedHash = createHash('sha256').update(await readFile(selectedPath)).digest('hex')
    if (selectedHash !== TUTORIAL_PAPER_SHA256) throw new Error('新手教程请选择窗口中预选的内置论文 Attention Is All You Need')
    const { created, failed } = await tasks.importPaths([selectedPath], { createDuplicates: request.createDuplicate, useOriginalFilename: false })
    if (failed[0]) throw new Error(failed[0].message)
    if (created[0]) return projectDocumentSummary(created[0])
    const existing = await repository.findByHash(TUTORIAL_PAPER_SHA256)
    if (!existing) throw new Error('内置教程论文导入失败')
    return projectDocumentSummary(existing)
  })
  ipc.handle(libraryChannels.list, () => deps.feed.list())
  ipc.handle(libraryChannels.retry, (_event, documentId) => {
    return tasks.retry(documentId)
  })
  ipc.handle(libraryChannels.delete, (_event, request) => deps.deleteDocument(request.documentId, request.deleteFiles))
  ipc.handle(libraryChannels.get, async (_event, documentId) => {
    const details = projectDocumentDetails(await tasks.getDocument(documentId))
    const summary = await repository.getDocumentSummary(documentId)
    return summary ? { ...details, summary } : details
  })
  ipc.handle(libraryChannels.openOutput, async (_event, documentId) => {
    const task = await repository.getTask(documentId)
    if (!task) throw new Error('文档不存在')
    const result = await shell.openPath(task.outputDir)
    if (result) throw new Error(result)
  })
  ipc.handle(libraryChannels.saveAs, async (_event, request) => {
    const task = await repository.getTask(request.documentId)
    if (!task) throw new Error('文档不存在')
    const extension = request.kind === 'result-zip' ? 'zip' : 'md'
    const exportStem = sanitizeTitleStem(task.title?.trim() || task.name.replace(/\.pdf$/i, '')) ?? `paper-${task.id.slice(0, 8)}`
    const result = await dialog.showSaveDialog(deps.mainWindow(), {
      defaultPath: join(app.getPath('downloads'), `${exportStem}${request.kind === 'translated-markdown' ? '.zh-CN' : ''}.${extension}`),
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    if (request.kind === 'result-zip') await tasks.createResultZip(task.id, result.filePath)
    else await tasks.exportMarkdown(task.id, request.kind, result.filePath)
    return { saved: true }
  })
}
