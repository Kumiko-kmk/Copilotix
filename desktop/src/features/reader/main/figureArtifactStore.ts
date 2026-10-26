import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { ReaderFigureGeometry } from '../core/readerFigureGroups'
import type { FigureArtifact, FigureArtifactManifest } from '../core/figureArtifacts'

const imagePathPattern = /^images\/figures\/figure-p\d+-[a-f0-9]{24}\.png$/u
const artifactSchema = z.object({
  figureId: z.string(), imagePath: z.string().regex(imagePathPattern), sourceRevision: z.string(),
  pageIndex: z.number().int().nonnegative(), cropBox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  mappingIds: z.array(z.string()), sourceAssets: z.array(z.string()),
  width: z.number().int().positive(), height: z.number().int().positive(), pngSha256: z.string()
}).strict()
const manifestSchema = z.object({ version: z.literal(1), figures: z.array(artifactSchema) }).strict()
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
// Keep verified file metadata, never PNG buffers. Reopening a long paper need
// not hash all earlier crops again for each newly generated figure.
const verifiedFiles = new Map<string, { size: number; mtimeMs: number; width: number; height: number }>()

export async function figureSourceRevision(outputDir: string, sourceHash: string, layoutJson: string): Promise<string> {
  const pdf = await stat(join(outputDir, 'original.pdf'))
  return sha256(JSON.stringify([sourceHash, pdf.size, pdf.mtimeMs, sha256(layoutJson)]))
}
export function figureGeometryKey(figure: Pick<ReaderFigureGeometry, 'pageIndex' | 'cropBox' | 'pageSize'>): string {
  return JSON.stringify([figure.pageIndex, figure.cropBox, figure.pageSize])
}
export function figureImagePath(figure: ReaderFigureGeometry, revision: string): string {
  return 'images/figures/figure-p' + (figure.pageIndex + 1) + '-' + sha256(revision + figure.id + figureGeometryKey(figure)).slice(0, 24) + '.png'
}
function pngSize(png: Buffer): [number, number] {
  if (png.length < 45 || png.length > 32 * 1024 * 1024 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    png.subarray(12, 16).toString() !== 'IHDR' || png.subarray(-8).toString('hex') !== '49454e44ae426082') throw new Error('整图必须是完整 PNG 图片')
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
  if (!width || !height || width > 8192 || height > 8192 || width * height > 8_000_000) throw new Error('整图超过画布上限')
  return [width, height]
}
export async function readFigureArtifacts(outputDir: string, revision: string, geometries: readonly ReaderFigureGeometry[]): Promise<FigureArtifact[]> {
  let manifest: z.infer<typeof manifestSchema>
  try { manifest = manifestSchema.parse(JSON.parse(await readFile(join(outputDir, 'figures.json'), 'utf8'))) } catch { return [] }
  const valid: FigureArtifact[] = []
  for (const artifact of manifest.figures) {
    const geometry = geometries.find(g => g.status === 'complete' && g.id === artifact.figureId)
    if (!geometry || artifact.sourceRevision !== revision || artifact.imagePath !== figureImagePath(geometry, revision)) continue
    try {
      const path = join(outputDir, artifact.imagePath)
      const info = await stat(path)
      if (info.size > 32 * 1024 * 1024) continue
      const key = path + ':' + artifact.pngSha256
      const cached = verifiedFiles.get(key)
      if (!cached || cached.size !== info.size || cached.mtimeMs !== info.mtimeMs || cached.width !== artifact.width || cached.height !== artifact.height) {
        const png = await readFile(path)
        const [width, height] = pngSize(png)
        if (width !== artifact.width || height !== artifact.height || sha256(png) !== artifact.pngSha256) continue
        verifiedFiles.set(key, { size: info.size, mtimeMs: info.mtimeMs, width, height })
        if (verifiedFiles.size > 512) verifiedFiles.delete(verifiedFiles.keys().next().value!)
      }
      valid.push({ ...artifact, pageIndex: geometry.pageIndex, cropBox: geometry.cropBox,
        mappingIds: geometry.mappingIds, sourceAssets: geometry.assetSources })
    } catch { /* Broken/missing crops are regenerated; source files remain available. */ }
  }
  return valid
}
export async function writeDerivedFile(path: string, data: Buffer | string): Promise<void> {
  const partial = path + '.partial-' + randomUUID()
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(partial, data, { flag: 'wx' })
    await rename(partial, path)
  } finally { await rm(partial, { force: true }).catch(() => undefined) }
}
export async function storeFigureArtifact(outputDir: string, revision: string, geometry: ReaderFigureGeometry,
  pngBase64: string, previous: readonly FigureArtifact[]): Promise<FigureArtifact> {
  const png = Buffer.from(pngBase64, 'base64')
  if (png.toString('base64') !== pngBase64) throw new Error('整图编码无效')
  const [width, height] = pngSize(png)
  const ratio = (geometry.cropBox[2] - geometry.cropBox[0]) / (geometry.cropBox[3] - geometry.cropBox[1])
  if (Math.abs(width - ratio * height) > ratio + 1) throw new Error('整图比例与 PDF 裁图不一致')
  const imagePath = figureImagePath(geometry, revision)
  const artifact = { figureId: geometry.id, imagePath, sourceRevision: revision, pageIndex: geometry.pageIndex,
    cropBox: geometry.cropBox, mappingIds: geometry.mappingIds, sourceAssets: geometry.assetSources, width, height, pngSha256: sha256(png) }
  await writeDerivedFile(join(outputDir, imagePath), png)
  const manifest: FigureArtifactManifest = { version: 1, figures: [...previous.filter(f => f.figureId !== geometry.id), artifact] }
  await writeDerivedFile(join(outputDir, 'figures.json'), JSON.stringify(manifest, null, 2) + '\n')
  return artifact
}
