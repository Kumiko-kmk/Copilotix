import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { TaskComputePort } from '../src/core/ports'
import { BLOCK_MAPPING_VERSION, buildBlockMappings } from '../src/main/blockMapping'

/** Test-only local compute port; production TaskService always receives RpcTaskCompute. */
export const fixtureTaskCompute: TaskComputePort = {
  hashFile,
  async importPdf(sourcePath) {
    const info = await import('node:fs/promises').then(({ stat }) => stat(sourcePath))
    return { sha256: await hashFile(sourcePath), size: info.size }
  },
  async normalizeParserOutput(task, extractedDir) {
    const files = await walkFiles(extractedDir)
    const markdown = files.find((path) => extname(path).toLowerCase() === '.md')
    const layout = files.find((path) => /(?:layout|middle)\.json$/iu.test(path))
    if (!markdown || !layout) throw new Error('fixture parser output incomplete')
    await copyFile(markdown, join(task.outputDir, 'full.md'))
    await copyFile(layout, join(task.outputDir, 'layout.json'))
    const mappings = buildBlockMappings(task.id, JSON.parse(await readFile(join(task.outputDir, 'layout.json'), 'utf8')))
    await writeFile(join(task.outputDir, 'block_list.json'), JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings }), 'utf8')
  },
  async rebuildMappings(taskId, outputDir) {
    const mappings = buildBlockMappings(taskId, JSON.parse(await readFile(join(outputDir, 'layout.json'), 'utf8')))
    await writeFile(join(outputDir, 'block_list.json'), JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings }), 'utf8')
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const input = createReadStream(path)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', resolvePromise)
    input.on('error', reject)
  })
  return hash.digest('hex')
}

async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...await walkFiles(path))
    else if (entry.isFile()) result.push(path)
  }
  return result
}
