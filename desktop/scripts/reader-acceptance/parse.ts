import { openAsBlob } from 'node:fs'
import { readFile, writeFile, mkdir, cp, copyFile, readdir, stat } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import extract from 'extract-zip'
import { WindowsCredentialVault } from '../../src/platform/credentials/main/credentialVault'
import { OfficialParserClient } from '../../src/features/parsing/main/parserClient'
import { buildBlockMappings, BLOCK_MAPPING_VERSION } from '../../src/features/parsing/core/blockMapping'

if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: parse <PDF> <result directory>')
const source = resolve(process.argv[2])
const destination = resolve(process.argv[3])
await mkdir(destination, { recursive: true })
const token = await new WindowsCredentialVault().get('parser-token')
if (!token) throw new Error('Configured MinerU credential is unavailable')
const client = new OfficialParserClient(fetch, {
  async upload(file, url) {
    const response = await fetch(url, { method: 'PUT', body: await openAsBlob(file), signal: AbortSignal.timeout(600_000) })
    if (!response.ok) throw new Error(`Upload HTTP ${response.status}`)
    await response.body?.cancel()
  }
}, { pollIntervalMs: 5000, maxWaitMs: 1800_000 })
const checkpointPath = join(destination, 'parse-checkpoint.json')
const sha256 = createHash('sha256').update(await readFile(source)).digest('hex')
let checkpoint: { batchId: string; dataId: string; sha256: string; startedAt: string; uploadedAt?: string }
try { checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  checkpoint = { batchId: '', dataId: crypto.randomUUID(), sha256, startedAt: new Date().toISOString() }
}
if (checkpoint.sha256 !== sha256) throw new Error('Checkpoint belongs to a different PDF')
if (!checkpoint.batchId) {
  const batch = await client.createUploadBatch([{ id: checkpoint.dataId, originalName: basename(source) } as never], {} as never, token)
  checkpoint.batchId = batch.batchId
  await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2))
  if (!batch.uploads[0]) throw new Error('Missing upload target')
  await client.uploadFile(source, batch.uploads[0].uploadUrl)
  checkpoint.uploadedAt = new Date().toISOString()
  await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2))
  console.log(JSON.stringify({ stage: 'uploaded', batchId: batch.batchId, bytes: (await stat(source)).size }))
} else if (!checkpoint.uploadedAt) {
  throw new Error('Upload outcome uncertain; inspect the remote batch before resubmitting')
}
let last = ''
const result = await client.waitForBatch(checkpoint.batchId, token, new Set([checkpoint.dataId]), result => {
  const state = JSON.stringify(result.entries.map(({ state, progress }) => ({ state, progress })))
  if (state !== last) { last = state; console.log(state) }
})
const done = result.entries.find(entry => entry.dataId === checkpoint.dataId)
if (!done?.fullZipUrl) throw new Error('Parser did not return a completed result')
const parsedAt = new Date().toISOString()
await client.downloadResult(done.fullZipUrl, join(destination, 'parser-result.zip'))
const extracted = join(destination, 'extracted')
await mkdir(extracted, { recursive: true })
await extract(join(destination, 'parser-result.zip'), { dir: extracted })
async function filesAt(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? filesAt(join(dir, entry.name)) : [join(dir, entry.name)]))).flat()
}
const files = await filesAt(extracted)
const markdown = files.find(file => basename(file) === 'full.md') ?? files.find(file => file.endsWith('.md'))
const layoutFile = files.find(file => basename(file) === 'layout.json') ?? files.find(file => file.endsWith('_middle.json'))
if (!markdown || !layoutFile) throw new Error('Missing Markdown or layout in parser result')
const paper = join(destination, 'paper')
await mkdir(paper, { recursive: true })
await cp(resolve(markdown, '..'), paper, { recursive: true })
await copyFile(markdown, join(paper, 'full.md'))
await copyFile(layoutFile, join(paper, 'layout.json'))
await copyFile(source, join(paper, 'original.pdf'))
const layout = JSON.parse(await readFile(layoutFile, 'utf8'))
const mappings = buildBlockMappings(checkpoint.dataId, layout)
if (!mappings.length) throw new Error('Parser layout produced no mappings')
await writeFile(join(paper, 'block_list.json'), JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings }))
const report = { provider: 'https://mineru.net', model: 'vlm', ...checkpoint, parsedAt, completedAt: new Date().toISOString(),
  parseSeconds: (Date.parse(parsedAt) - Date.parse(checkpoint.startedAt)) / 1000, pages: layout.pdf_info?.length, mappings: mappings.length, sourceBytes: (await stat(source)).size }
await writeFile(join(destination, 'parse-report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
