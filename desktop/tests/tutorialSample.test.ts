import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { TUTORIAL_PAPER_BYTES, TUTORIAL_PAPER_SHA256 } from '@shared/tutorialSample'
import { tutorialPaperPath, verifiedTutorialPaperPath } from '@main/tutorialSample'

describe('tutorial sample', () => {
  it('ships the exact readable PDF used by the guided import', async () => {
    const bundleDirectory = join(process.cwd(), 'out', 'main')
    const options = { isPackaged: false, bundleDirectory, resourcesPath: '' }
    expect(tutorialPaperPath(options)).toBe(join(process.cwd(), 'resources', 'tutorial', 'Attention Is All You Need.pdf'))
    expect(await verifiedTutorialPaperPath(options)).toBe(tutorialPaperPath(options))
    expect(TUTORIAL_PAPER_BYTES).toBe(2_215_244)
    expect(TUTORIAL_PAPER_SHA256).toHaveLength(64)
    expect(tutorialPaperPath({ ...options, isPackaged: true, resourcesPath: 'C:/release/resources' })).toBe(join('C:/release/resources', 'tutorial', 'Attention Is All You Need.pdf'))
  })
})
