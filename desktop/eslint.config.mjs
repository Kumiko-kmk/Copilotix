import eslint from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const sourceFiles = ['src/**/*.ts', 'src/**/*.tsx']
const testFiles = ['tests/**/*.ts', 'tests/**/*.tsx']
const configFiles = ['electron.vite.config.ts', 'utility.vite.config.ts', 'vitest.config.ts', 'playwright.config.ts']
const typedFiles = [...sourceFiles, ...testFiles, ...configFiles]

/** Files of process layers in app/, platform/<concern>/ and features/<name>/ (ADR-0001). */
const layerFiles = (...layers) => layers.flatMap(layer => ['app', 'platform/*', 'features/*'].map(unit => `src/${unit}/${layer}/**/*.{ts,tsx}`))
/** Alias imports that reach into those layers. */
const layerImports = (...layers) => layers.flatMap(layer => [`@app/${layer}/**`, `@platform/*/${layer}/**`, `@features/*/${layer}/**`])

export default tseslint.config(
  {
    ignores: ['out/**', 'release/**', 'node_modules/**', 'dist/**']
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: typedFiles,
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...globals.es2024 },
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  {
    files: layerFiles('core', 'contract'),
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: [...layerImports('main', 'preload', 'renderer', 'runtime', 'utility'), 'electron', 'node:*'], message: 'Core code cannot depend on a runtime layer.' }
          ]
        }
      ]
    }
  },
  {
    files: layerFiles('preload'),
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: layerImports('main', 'renderer', 'runtime', 'utility'), message: 'Preload may depend on contracts, not main, renderer or runtime modules.' }
          ]
        }
      ]
    }
  },
  {
    files: layerFiles('renderer'),
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: [...layerImports('main', 'preload', 'runtime', 'utility'), 'electron', 'node:*'], message: 'Renderer must use the preload API for privileged work.' }
          ]
        }
      ]
    }
  },
  {
    files: layerFiles('main'),
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: layerImports('renderer'), message: 'Main cannot depend on renderer modules.' }]
        }
      ]
    }
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] }
  }
)
