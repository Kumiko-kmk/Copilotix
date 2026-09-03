import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core')
    }
  },
  build: {
    target: 'node20',
    outDir: resolve(__dirname, 'out/utility'),
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/utility/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.js'
    },
    rollupOptions: {
      // The utility is a Node process. Keep every Node builtin external so
      // runtime-only modules such as node:sqlite are not browser-shimmed.
      external: [/^node:/u, 'electron']
    }
  }
})
