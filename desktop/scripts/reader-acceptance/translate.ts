import PQueue from 'p-queue'
import { systemQwenFetch } from './qwenTransport'
import { DatabaseSync } from 'node:sqlite'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { WindowsCredentialVault, type CredentialAccount } from '../../src/platform/credentials/main/credentialVault'
import { DEFAULT_SETTINGS } from '../../src/features/settings/contract/defaultSettings'
import { defaultConnections, modelConnectionsSchema, type ProviderKey } from '../../src/platform/models/contract/models'
import { keyConnection } from '../../src/platform/models/runtime/modelRuntime'
import { V2Database } from '../../src/platform/database/utility/v2Database'
import { V2TaskRepositoryCompat } from '../../src/features/library/utility/v2TaskRepositoryCompat'
import { MarkdownTranslationPlanManager } from '../../src/features/translation/utility/markdownTranslationPlan'
import { TranslationPlanOrchestrator } from '../../src/features/translation/main/translationPlanOrchestrator'
import { createTranslationProviders } from '../../src/features/translation/main/providers'
import type { TaskComputePort } from '../../src/features/library/contract/taskCompute'

if (!process.argv[2]) throw new Error('Usage: translate <isolated acceptance directory>')
const root = resolve(process.argv[2])
const paper = join(root, 'paper')
const sourceDb = new DatabaseSync(join(process.env.APPDATA!, 'Copilotix-Translation-v2', 'copilotix-desktop-v2.sqlite3'), { readOnly: true })
const stored = sourceDb.prepare('SELECT value FROM settings WHERE key=?').get('modelConnections') as { value: string } | undefined
sourceDb.close()
const connections = stored ? modelConnectionsSchema.parse(JSON.parse(stored.value)) : defaultConnections()
const vault = new WindowsCredentialVault()
const keys: ProviderKey[] = []
for (const connection of connections.filter(c => c.provider === 'qwen' && c.enabled).sort((a, b) => a.priority - b.priority)) {
  const key = await vault.get(connection.credentialRef as CredentialAccount)
  if (key) keys.push({ connection: keyConnection(connection, key), key })
}
if (!keys.length) throw new Error('No configured Qwen credential available')
const database = new V2Database(join(root, 'translation-acceptance.sqlite3'))
const repository = new V2TaskRepositoryCompat(database)
const id = '6d215e7c-0849-4519-9e17-b67af4385816'
const now = new Date().toISOString()
if (!repository.getTask(id)) {
  repository.insertTask({ id, originalName: 'original.pdf', title: null, name: 'original.pdf', sourcePath: join(paper, 'original.pdf'),
    sourceHash: createHash('sha256').update(await readFile(join(paper, 'original.pdf'))).digest('hex'), outputDir: paper,
    status: 'uploading', progress: 0, translationProvider: 'qwen', remoteBatchId: null, remoteDataId: null, remoteResultUrl: null,
    error: null, createdAt: now, updatedAt: now })
  repository.updateTask(id, { status: 'translating', progress: 0 })
}
const task = repository.getTask(id)!
const binding = database.connection.prepare("SELECT id FROM jobs WHERE document_id=? AND kind='translate'").get(id) as { id: string }
const manager = new MarkdownTranslationPlanManager(repository)
const compute = {
  openTranslationPlan: manager.open.bind(manager), listTranslationWork: manager.listWork.bind(manager),
  tryTranslationCache: manager.tryCache.bind(manager), applyTranslation: manager.apply.bind(manager),
  failTranslation: manager.fail.bind(manager), finalizeTranslation: manager.finalize.bind(manager)
} as TaskComputePort
// Queue whole model calls so transport timeouts exclude waiting for other units.
const fetchQwen = systemQwenFetch()
const requests = new PQueue({ concurrency: 1, interval: 1500, intervalCap: 1 })
const providers = createTranslationProviders(DEFAULT_SETTINGS, async provider => provider === 'qwen' ? keys : [], async (url, init) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetchQwen(url, init)
      if (response.status === 429 && attempt < 2) {
        await response.body?.cancel()
        console.log(JSON.stringify({ httpStatus: 429, waitSeconds: 30 }))
        await new Promise(resolve => setTimeout(resolve, 30_000))
        continue
      }
      return response
    } catch (error) {
      if (attempt >= 2 || init?.signal?.aborted) throw error
      console.log(JSON.stringify({ networkRetry: attempt + 1, message: (error as Error).message, code: (error as { cause?: { code?: string } }).cause?.code }))
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
  }
})
const qwen = providers.get('qwen')!
providers.set('qwen', { id: qwen.id, model: qwen.model, isAvailable: () => qwen.isAvailable(),
  translate: (text, signal) => requests.add(() => qwen.translate(text, signal), { signal }) as Promise<string>,
  translateTable: (request, signal) => requests.add(() => qwen.translateTable(request, signal), { signal }) as ReturnType<typeof qwen.translateTable>
})
const controller = new AbortController()
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)])
process.once('SIGINT', () => controller.abort())
const started = performance.now()
let lastReport = 0
try {
  const result = await new TranslationPlanOrchestrator({ task, jobId: binding.id, compute,
    providers,
    providerOrder: ['qwen'], signal, onProgress({ counts }) {
      if (performance.now() - lastReport > 10_000) { lastReport = performance.now(); console.log(JSON.stringify(counts)) }
    }
  }).run()
  const report = { provider: 'qwen', model: DEFAULT_SETTINGS.qwenModel, startedAt: now, seconds: (performance.now() - started) / 1000, result }
  await writeFile(join(root, 'translation-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { controller.abort(); await requests.onIdle(); repository.close() }
