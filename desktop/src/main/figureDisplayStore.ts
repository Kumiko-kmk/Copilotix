import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  FIGURE_DISPLAY_MAX,
  figureDisplayChoicesSchema,
  figureDisplayFileSchema,
  type FigureDisplayChoices,
  type FigureDisplaySetRequest
} from '@shared/figureDisplay'

/**
 * Reader figure display choices, one small JSON file in each document folder. It is backed up,
 * restored and migrated with the folder; a missing or damaged file means "automatic" for every
 * figure. Writes for one document are serialised and published atomically.
 */
export class FigureDisplayStore {
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly outputDirOf: (documentId: string) => Promise<string | null>) {}

  async get(documentId: string): Promise<FigureDisplayChoices> {
    return { choices: await this.read(await this.requireDir(documentId)) }
  }

  set(request: FigureDisplaySetRequest): Promise<FigureDisplayChoices> {
    const run = async (): Promise<FigureDisplayChoices> => {
      const dir = await this.requireDir(request.documentId)
      const choices = await this.read(dir)
      if (request.choice) choices[request.figureId] = request.choice
      else delete choices[request.figureId]
      if (Object.keys(choices).length > FIGURE_DISPLAY_MAX) throw new Error('图片显示选择过多')
      await writeJsonAtomic(join(dir, 'reader', 'figure-display.v1.json'), figureDisplayFileSchema.parse({ version: 1, choices }))
      return figureDisplayChoicesSchema.parse({ choices })
    }
    const previous = this.queues.get(request.documentId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(run)
    this.queues.set(request.documentId, next)
    void next.finally(() => { if (this.queues.get(request.documentId) === next) this.queues.delete(request.documentId) }).catch(() => undefined)
    return next
  }

  private async requireDir(documentId: string): Promise<string> {
    const dir = await this.outputDirOf(documentId)
    if (!dir) throw new Error('文档不存在')
    return dir
  }

  private async read(dir: string): Promise<Record<string, 'pdf' | 'parsed'>> {
    try {
      const parsed = figureDisplayFileSchema.safeParse(JSON.parse(await readFile(join(dir, 'reader', 'figure-display.v1.json'), 'utf8')))
      return parsed.success ? { ...parsed.data.choices } : {}
    } catch {
      return {}
    }
  }
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const partial = `${target}.partial-${randomUUID()}`
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(partial, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    const handle = await open(partial, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(partial, target)
  } finally {
    await rm(partial, { force: true }).catch(() => undefined)
  }
}
