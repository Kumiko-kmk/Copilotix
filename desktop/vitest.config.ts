import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared'), '@main': resolve(__dirname, 'src/main') } },
  test: {
    environment: 'node',
    exclude: ['e2e/**', 'node_modules/**', 'dist/**', 'out/**'],
    coverage: { reporter: ['text', 'html'] }
  }
})
