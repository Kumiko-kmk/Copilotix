import { describe, expect, it } from 'vitest'
import { shouldIncludeResultZipEntry } from '../src/main/artifactService'

describe('result archive filtering', () => {
  it('excludes only the root .translation tree, including dotfiles', () => {
    expect(shouldIncludeResultZipEntry('.translation')).toBe(false)
    expect(shouldIncludeResultZipEntry('.translation/plan.json')).toBe(false)
    expect(shouldIncludeResultZipEntry('.translation/job/responses/.hidden.json')).toBe(false)
    expect(shouldIncludeResultZipEntry('.translationary/notes.md')).toBe(true)
    expect(shouldIncludeResultZipEntry('nested/.translation/notes.md')).toBe(true)
    expect(shouldIncludeResultZipEntry('.gitignore')).toBe(true)
  })
})
