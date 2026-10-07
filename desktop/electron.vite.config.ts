import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        // zod is bundled (tree-shaken) like in preload, so it does not ship in app.asar.
        exclude: ['p-queue', 'remark-gfm', 'remark-math', 'remark-parse', 'remark-stringify', 'unified', 'uuid', 'zod']
      })
    ],
    resolve: { alias: { '@shared': resolve('src/shared'), '@core': resolve('src/core'), '@main': resolve('src/main') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer') } },
    plugins: [react()]
  }
})
