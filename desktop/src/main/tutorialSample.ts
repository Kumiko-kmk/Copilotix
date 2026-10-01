import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TUTORIAL_PAPER_BYTES, TUTORIAL_PAPER_FILENAME, TUTORIAL_PAPER_SHA256 } from '@shared/tutorialSample'

export function tutorialPaperPath(options: { isPackaged: boolean; bundleDirectory: string; resourcesPath: string }): string {
  return options.isPackaged
    ? join(options.resourcesPath, 'tutorial', TUTORIAL_PAPER_FILENAME)
    : join(options.bundleDirectory, '..', '..', 'resources', 'tutorial', TUTORIAL_PAPER_FILENAME)
}

export async function verifiedTutorialPaperPath(options: { isPackaged: boolean; bundleDirectory: string; resourcesPath: string }): Promise<string> {
  const path = tutorialPaperPath(options)
  const bytes = await readFile(path)
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (bytes.length !== TUTORIAL_PAPER_BYTES || hash !== TUTORIAL_PAPER_SHA256) {
    throw new Error('内置教程论文缺失或校验失败，请重新安装应用')
  }
  return path
}
