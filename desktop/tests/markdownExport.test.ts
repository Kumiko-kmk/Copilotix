import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import extractZip from 'extract-zip'
import { describe, expect, it } from 'vitest'
import { ArtifactService } from '../src/main/artifactService'
import { PathPolicy } from '../src/main/pathPolicy'
import type { TaskRepositoryCompat } from '../src/main/taskRepositoryCompat'
import type { TaskComputePort } from '../src/core/ports'
import type { CopilotixTask } from '../src/shared/types'
import { LEGACY_TRANSLATION_PIPELINE_VERSION, TABLE_TRANSLATION_PROTOCOL } from '../src/shared/translationPlanProtocol'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'copilotix-markdown-export-'))
  const outputDir = join(root, 'library')
  const exports = join(root, 'exports')
  await mkdir(join(outputDir, 'images'), { recursive: true })
  await mkdir(exports)
  const task = { id: '11111111-1111-4111-8111-111111111111', outputDir } as CopilotixTask
  const repository = { getTask: async (id: string) => id === task.id ? task : null } as unknown as TaskRepositoryCompat
  const compute = {} as TaskComputePort
  const service = new ArtifactService(repository, compute, new PathPolicy())
  return { root, outputDir, exports, task, service }
}

describe('standard Markdown export and transfer', () => {
  it('normalizes legacy HTML and bundles each local image once, including reference and HTML images', async () => {
    const f = await fixture()
    try {
      const source = '<table><tr><td>Model</td></tr><tr><td>DDPM $x^2$</td></tr></table>\n\n![图][figure]\n\n<img src="images/a%20b.png">\n\n![remote](https://example.org/a.png)\n\n[figure]: images/a%20b.png'
      await writeFile(join(f.outputDir, 'full.md'), source)
      await writeFile(join(f.outputDir, 'images/a b.png'), 'real image bytes')
      const destination = join(f.exports, '论文.md')
      await f.service.exportMarkdown(f.task.id, 'original-markdown', destination)
      const markdown = await readFile(destination, 'utf8')
      expect(markdown).toContain('| Model')
      expect(markdown).toContain('$x^2$')
      expect(markdown).not.toContain('<table')
      expect(markdown).toContain('https://example.org/a.png')
      const assetFolders = (await readdir(f.exports)).filter((name) => name.includes('.assets-'))
      expect(assetFolders).toHaveLength(1)
      const images = await readdir(join(f.exports, assetFolders[0]!))
      expect(images).toEqual(['1-a b.png'])
      expect(await readFile(join(f.exports, assetFolders[0]!, images[0]!), 'utf8')).toBe('real image bytes')
      expect(markdown).toContain(`${encodeURIComponent(assetFolders[0]!)}/1-a%20b.png`)
      expect(await readFile(join(f.outputDir, 'full.md'), 'utf8')).toBe(source)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('exports recovered legacy manifest blocks instead of a missing/stale projection', async () => {
    const f = await fixture()
    try {
      await writeFile(join(f.outputDir, 'translation.manifest.json'), JSON.stringify({
        version: 2, taskId: f.task.id, translationPipelineVersion: LEGACY_TRANSLATION_PIPELINE_VERSION,
        tableTranslationProtocol: TABLE_TRANSLATION_PROTOCOL,
        blocks: [{ sourceIndex: 0, markdown: '<table><tr><td>模型</td></tr><tr><td>基线</td></tr></table>', mappingIds: [] }]
      }))
      const destination = join(f.exports, '中文.md')
      await f.service.exportMarkdown(f.task.id, 'translated-markdown', destination)
      expect(await readFile(destination, 'utf8')).toContain('| 模型')
      await writeFile(join(f.outputDir, 'full.zh-CN.md'), 'stale')
      await f.service.exportMarkdown(f.task.id, 'translated-markdown', destination)
      expect(await readFile(destination, 'utf8')).not.toContain('stale')
      expect(await readdir(f.exports)).toEqual(['中文.md'])
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('leaves an existing export intact and cleans staging when a required image is missing', async () => {
    const f = await fixture()
    try {
      await writeFile(join(f.outputDir, 'full.md'), '![missing](images/missing.png)')
      const destination = join(f.exports, 'paper.md')
      await writeFile(destination, 'existing document')
      await expect(f.service.exportMarkdown(f.task.id, 'original-markdown', destination)).rejects.toThrow()
      expect(await readFile(destination, 'utf8')).toBe('existing document')
      expect(await readdir(f.exports)).toEqual(['paper.md'])
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('rejects traversal images, library overwrite, directories and absent tasks', async () => {
    const f = await fixture()
    try {
      await writeFile(join(f.outputDir, 'full.md'), '![escape](../secret.png)')
      await expect(f.service.exportMarkdown(f.task.id, 'original-markdown', join(f.exports, 'bad.md'))).rejects.toThrow('..')
      await expect(f.service.exportMarkdown(f.task.id, 'original-markdown', join(f.outputDir, 'full.md'))).rejects.toThrow('文档库以外')
      await expect(f.service.exportMarkdown(f.task.id, 'original-markdown', f.exports)).rejects.toThrow('普通文件')
      await expect(f.service.exportMarkdown('absent', 'original-markdown', join(f.exports, 'bad.md'))).rejects.toThrow('不存在')
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('normalizes both Markdown files in result ZIPs and excludes durable plan internals', async () => {
    const f = await fixture()
    try {
      await writeFile(join(f.outputDir, 'full.md'), '<table><tr><td>Source</td></tr></table>')
      await writeFile(join(f.outputDir, 'full.zh-CN.md'), '<table><tr><td>译文</td></tr></table>')
      await mkdir(join(f.outputDir, '.translation'))
      await writeFile(join(f.outputDir, '.translation/request.json'), 'private plan')
      await writeFile(join(f.outputDir, 'images/a.png'), 'image')
      const destination = join(f.exports, 'result.zip')
      await f.service.createResultZip(f.task.id, destination)
      const unpacked = join(f.exports, 'unpacked')
      await extractZip(destination, { dir: unpacked })
      expect(await readFile(join(unpacked, 'full.md'), 'utf8')).toContain('| Source')
      expect(await readFile(join(unpacked, 'full.zh-CN.md'), 'utf8')).toContain('| 译文')
      expect(await readdir(unpacked)).not.toContain('.translation')
      expect(await readFile(join(unpacked, 'images/a.png'), 'utf8')).toBe('image')
      expect((await readdir(f.exports)).some((name) => name.includes('.partial'))).toBe(false)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
})
