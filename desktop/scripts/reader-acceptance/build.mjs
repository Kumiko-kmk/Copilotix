import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, copyFile, writeFile, cp } from 'node:fs/promises'
const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '../..')
const output = resolve(desktop, '../output/reader-acceptance-20261031')
const stage = join(output, 'app')
await mkdir(stage, { recursive: true })
await build({ configFile: false, root: here, base: './', plugins: [react()],
  resolve: { dedupe: ['katex'], alias: { '@features': join(desktop, 'src/features'), '@platform': join(desktop, 'src/platform'), '@app': join(desktop, 'src/app') } },
  build: { outDir: join(stage, 'renderer'), emptyOutDir: true, rollupOptions: { input: join(here, 'index.html') } } })
await copyFile(join(here, 'main.cjs'), join(stage, 'main.cjs'))
await copyFile(resolve(desktop, '../LICENSE.md'), join(stage, 'LICENSE.md'))
await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'copilotix-reader-acceptance', version: '1.3.1',
  productName: 'Copilotix Reader Acceptance', main: 'main.cjs', description: 'Local PDF reader acceptance build', author: 'Copilotix', license: 'MIT' }, null, 2))
if (process.argv[2]) {
  const paper = resolve(process.argv[2])
  const destination = join(stage, 'paper')
  await mkdir(destination, { recursive: true })
  for (const name of ['original.pdf', 'full.md', 'layout.json', 'block_list.json', 'full.zh-CN.md', 'translation.manifest.json']) await copyFile(join(paper, name), join(destination, name))
  await cp(join(paper, 'images'), join(destination, 'images'), { recursive: true })
}
console.log(`Acceptance app: ${stage}`)
