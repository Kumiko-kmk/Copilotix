import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const here = dirname(fileURLToPath(import.meta.url))
const entry = process.argv[2] === 'translate' ? 'translate' : 'parse'
await build({ entryPoints: [resolve(here, entry + '.ts')], outfile: resolve(here, entry + '.generated.mjs'),
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  alias: { '@features': resolve(here, '../../src/features'), '@platform': resolve(here, '../../src/platform'), '@app': resolve(here, '../../src/app') } })
