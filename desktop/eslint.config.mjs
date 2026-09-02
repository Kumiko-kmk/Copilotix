import eslint from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const sourceFiles = ['src/**/*.ts', 'src/**/*.tsx']
const testFiles = ['tests/**/*.ts', 'tests/**/*.tsx']
const configFiles = ['electron.vite.config.ts', 'vitest.config.ts', 'playwright.config.ts']
const typedFiles = [...sourceFiles, ...testFiles, ...configFiles]

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
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@main/*', '@renderer/*', 'electron', 'node:*'], message: 'Shared code cannot depend on a runtime layer.' }
          ]
        }
      ]
    }
  },
  {
    files: ['src/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@main/*', '@renderer/*'], message: 'Preload may depend on shared contracts, not main or renderer modules.' }
          ]
        }
      ]
    }
  },
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@main/*', 'electron', 'node:*'], message: 'Renderer must use the preload API for privileged work.' }
          ]
        }
      ]
    }
  },
  {
    files: ['src/main/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['@renderer/*'], message: 'Main cannot depend on renderer modules.' }]
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
