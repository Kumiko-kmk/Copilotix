import { access, copyFile, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { _electron as electron } from '@playwright/test'
import { BLOCK_MAPPING_VERSION, buildBlockMappings } from '../src/core/blockMapping'
import { TABLE_TRANSLATION_PROTOCOL, TRANSLATION_PIPELINE_VERSION } from '../src/shared/translationPlanProtocol'
import { V2Database } from '../src/utility/core/persistence/v2Database'
import { V2TaskRepositoryCompat } from '../src/utility/core/persistence/v2TaskRepositoryCompat'
import type { ArtifactKind } from '../src/core/types'
import { shouldDisableGpuSandbox, shouldUseHostCompatibilityMode } from '../src/shared/e2eLaunchPolicy'
import { credentialServiceForRuntime, WindowsCredentialVault, type CredentialAccount } from '../src/main/credentialVault'
import {
  alignMarkdownBlocks,
  MARKDOWN_MAPPING_ALGORITHM_VERSION,
  splitMarkdownBlocks
} from '../src/shared/markdownBlocks'

const FIXTURE_MARKDOWN = [
  '# Fixture document',
  '<sub>Ada Lovelace</sub> and Alan Turing',
  'Abstract | A separately mapped summary.',
  'First page continues in second column.<sup>12</sup> Water is H<sub>2</sub>O.',
  'Second paragraph with $E=mc^2$.',
  '<table><tbody><tr><td>Academic cell</td></tr></tbody></table>',
  '![Fixture image](images/fixture.png)'
].join('\n\n')

const ALIGNMENT_REGRESSION_MARKDOWN = [
  '# Alignment regression',
  'The abstract explains what happens then and furthermore motivates the method.',
  'Keywords: operators',
  'Then',
  'First equation explanation.',
  'Furthermore,',
  'Furthermore,'
].join('\n\n')

export interface E2EWorkspace {
  root: string
  userData: string
  env: NodeJS.ProcessEnv
  cleanup(): Promise<void>
}

export async function createE2EWorkspace(): Promise<E2EWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'copilotix-e2e-'))
  const userData = join(root, 'user-data')
  await mkdir(userData, { recursive: true })
  return {
    root,
    userData,
    env: { ...process.env, NODE_ENV: 'test', COPILOTIX_E2E_USER_DATA: userData },
    cleanup: async () => {
      const vault = new WindowsCredentialVault(credentialServiceForRuntime({
        isPackaged: false, nodeEnv: 'test', e2eUserData: userData
      }))
      const accounts: CredentialAccount[] = [
        'parser-token', 'qwen-api-key', 'deepseek-api-key',
        'parser-token-validation', 'qwen-api-key-validation', 'deepseek-api-key-validation'
      ]
      try {
        await Promise.all(accounts.map((account) => vault.delete(account)))
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
}

export async function seedReaderTask(
  workspace: E2EWorkspace,
  options?: {
    missingPdf?: boolean
    sourcePdf?: string
    sourceTaskDir?: string
    sourceMarkdown?: string
    translatedMarkdown?: string
    supplementalBlocks?: boolean
    alignmentRegression?: boolean
    legacyTranslationManifest?: boolean
    englishTitle?: string
  }
): Promise<string> {
  const taskId = options?.missingPdf
    ? '00000000-0000-4000-8000-000000000001'
    : options?.sourceTaskDir
      ? '00000000-0000-4000-8000-000000000002'
      : options?.sourcePdf
        ? '00000000-0000-4000-8000-000000000003'
        : options?.alignmentRegression
          ? '00000000-0000-4000-8000-000000000004'
          : '00000000-0000-4000-8000-000000000005'
  const outputDir = join(workspace.root, 'documents-v2', taskId)
  const originalName = options?.missingPdf
    ? 'missing.pdf'
    : options?.sourceTaskDir
      ? basename(options.sourceTaskDir)
      : options?.sourcePdf
        ? basename(options.sourcePdf)
        : 'fixture.pdf'
  const taskName = options?.englishTitle ? `${options.englishTitle}.pdf` : originalName
  const pdfPath = join(outputDir, 'original.pdf')
  await mkdir(outputDir, { recursive: true })
  if (options?.sourceTaskDir) {
    await cp(options.sourceTaskDir, outputDir, { recursive: true })
    try {
      const manifestPath = join(outputDir, 'translation.manifest.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
      await writeFile(manifestPath, JSON.stringify({ ...manifest, taskId }, null, 2), 'utf8')
    } catch {
      // Layout-only fixtures do not contain a translation manifest.
    }
  } else {
    const fixtureMarkdown = options?.sourceMarkdown ?? (options?.alignmentRegression ? ALIGNMENT_REGRESSION_MARKDOWN : FIXTURE_MARKDOWN)
    const layout = options?.alignmentRegression
      ? createAlignmentRegressionLayoutFixture()
      : createLayoutFixture(options?.supplementalBlocks)
    if (options?.sourcePdf) await copyFile(options.sourcePdf, pdfPath)
    else if (!options?.missingPdf) await writeFile(pdfPath, createTwoPagePdf())
    const imagesDir = join(outputDir, 'images')
    await mkdir(imagesDir, { recursive: true })
    await copyFile(join(__dirname, '../resources/icon.png'), join(imagesDir, 'fixture.png'))
    await writeFile(join(outputDir, 'full.md'), fixtureMarkdown, 'utf8')
    if (options?.translatedMarkdown !== undefined) {
      await writeFile(join(outputDir, 'full.zh-CN.md'), options.translatedMarkdown, 'utf8')
      const sourceBlocks = alignMarkdownBlocks(fixtureMarkdown, buildBlockMappings(taskId, layout))
      const translatedBlocks = splitMarkdownBlocks(options.translatedMarkdown)
      if (translatedBlocks.length !== sourceBlocks.length) {
        throw new Error(`Fixture translation block count ${translatedBlocks.length} does not match source ${sourceBlocks.length}`)
      }
      await writeFile(join(outputDir, 'translation.manifest.json'), JSON.stringify({
        version: 2,
        ...(options?.legacyTranslationManifest ? {} : {
          mappingAlgorithmVersion: MARKDOWN_MAPPING_ALGORITHM_VERSION,
          blockMappingVersion: BLOCK_MAPPING_VERSION,
          translationPipelineVersion: TRANSLATION_PIPELINE_VERSION,
          tableTranslationProtocol: TABLE_TRANSLATION_PROTOCOL
        }),
        taskId,
        targetLanguage: 'zh-CN',
        preferredProvider: 'qwen',
        failedBlockIds: [],
        blocks: translatedBlocks.map((markdown, sourceIndex) => ({
          blockId: `fixture-translation-${sourceIndex}`,
          sourceIndex,
          mappingIds: sourceBlocks[sourceIndex]?.mappingIds ?? [],
          sourceHash: `fixture-source-${sourceIndex}`,
          markdown,
          provider: 'qwen',
          model: 'fixture',
          status: 'completed',
          error: null
        }))
      }, null, 2), 'utf8')
    }
    await writeFile(join(outputDir, 'layout.json'), JSON.stringify(layout), 'utf8')
  }

  const database = new V2Database(join(workspace.userData, 'copilotix-desktop-v2.sqlite3'))
  const repository = new V2TaskRepositoryCompat(database)
  const now = new Date().toISOString()
  const taskStatus = options?.missingPdf ? 'failed' : 'completed'
  repository.insertTask({
    id: taskId,
    originalName,
    title: options?.englishTitle ?? null,
    name: taskName,
    sourcePath: pdfPath,
    sourceHash: 'fixture-hash',
    outputDir,
    status: taskStatus,
    progress: taskStatus === 'completed' ? 100 : 0,
    parserModel: 'vlm',
    translationProvider: 'qwen',
    remoteBatchId: null,
    remoteDataId: null,
    remoteResultUrl: null,
    error: options?.missingPdf ? 'fixture missing file' : null,
    createdAt: now,
    updatedAt: now
  })
  repository.updateTask(taskId, {
    status: taskStatus,
    progress: taskStatus === 'completed' ? 100 : 0,
    error: options?.missingPdf ? 'fixture missing file' : null
  })
  const artifacts: Array<[ArtifactKind, string]> = [
    ['parsed_markdown', join(outputDir, 'full.md')],
    ['layout', join(outputDir, 'layout.json')],
    ['block_mappings', join(outputDir, 'block_list.json')],
    ['content_list', join(outputDir, 'content_list.json')],
    ['translated_markdown', join(outputDir, 'full.zh-CN.md')],
    ['manifest', join(outputDir, 'translation.manifest.json')]
  ]
  for (const [kind, path] of artifacts) {
    try {
      await access(path)
      repository.recordArtifactRevision(taskId, kind, path, `fixture-${kind}`)
    } catch {
      // Some fixtures intentionally omit translated or supplemental files.
    }
  }
  repository.close()
  return taskId
}

/**
 * All Electron launches share the same test-only host policy. This Windows
 * host rejects Chromium sandbox subprocess startup before renderer code runs,
 * so trusted local E2E fixtures bypass that host boundary. Production keeps
 * the BrowserWindow sandbox. Switches are inserted before the development entry.
 */
export function launchElectron(options: {
  args?: string[]
  executablePath?: string
  env?: NodeJS.ProcessEnv
}) {
  const env = { ...process.env, ...(options.env ?? {}) }
  const args = [...(options.args ?? [])]
  if (shouldDisableGpuSandbox(env)) args.unshift('--disable-gpu-sandbox')
  if (shouldUseHostCompatibilityMode(env)) args.unshift('--no-sandbox')
  return electron.launch({ ...options, args, env })
}

function createLayoutFixture(supplementalBlocks = false): object {
  return {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [612, 792],
        para_blocks: [
          {
            index: 0,
            type: 'title',
            bbox: [72, 72, 300, 100],
            lines: [{ bbox: [72, 72, 300, 100], spans: [{ type: 'text', content: 'Fixture document' }] }]
          },
          {
            index: 1,
            type: 'text',
            bbox: [72, 110, 500, 140],
            lines: [{ bbox: [72, 110, 500, 140], spans: [{ type: 'text', content: 'Ada Lovelace and Alan Turing' }] }]
          },
          {
            index: 2,
            type: 'text',
            bbox: [72, 150, 540, 200],
            lines: [{ bbox: [72, 150, 540, 200], spans: [{ type: 'text', content: 'Abstract | A separately mapped summary.' }] }]
          },
          {
            index: 3,
            type: 'text',
            bbox: [72, 220, 300, 270],
            lines: [
              { bbox: [72, 220, 300, 240], spans: [{ type: 'text', content: 'First page' }] },
              { bbox: [330, 220, 560, 240], spans: [{ type: 'text', content: 'continues in second column.' }] }
            ]
          },
          { index: 4, type: 'text', bbox: [330, 210, 560, 270], lines: [], lines_deleted: true },
        ],
        discarded_blocks: supplementalBlocks ? [
          {
            index: -1,
            type: 'page_header',
            bbox: [72, 28, 540, 44],
            lines: [{ bbox: [72, 28, 540, 44], spans: [{ type: 'text', content: 'Fixture journal header' }] }]
          },
          {
            index: 100,
            type: 'page_footnote',
            bbox: [72, 700, 540, 724],
            lines: [{ bbox: [72, 700, 540, 724], spans: [{ type: 'text', content: '<sub>*</sub>. Fixture conference footnote' }] }]
          },
          {
            index: 101,
            type: 'page_footer',
            bbox: [72, 732, 540, 748],
            lines: [{ bbox: [72, 732, 540, 748], spans: [{ type: 'text', content: 'Fixture author footer' }] }]
          },
          {
            index: 102,
            type: 'page_number',
            bbox: [290, 758, 320, 778],
            lines: [{ bbox: [290, 758, 320, 778], spans: [{ type: 'text', content: '315' }] }]
          }
        ] : []
      },
      {
        page_idx: 1,
        page_size: [612, 792],
        para_blocks: [
          {
            index: 0,
            type: 'text',
            bbox: [72, 220, 300, 260],
            lines: [{ bbox: [72, 220, 300, 240], spans: [{ type: 'text', content: 'Second paragraph with' }] }]
          },
          {
            index: 1,
            type: 'text',
            bbox: [72, 275, 300, 295],
            lines: [{ bbox: [72, 275, 300, 295], spans: [{ type: 'text', content: 'Academic cell' }] }]
          },
          {
            index: 2,
            type: 'image',
            bbox: [72, 300, 300, 460],
            lines: [{ bbox: [72, 300, 300, 460], spans: [{ type: 'image', image_path: 'images/fixture.png' }] }]
          }
        ],
        discarded_blocks: supplementalBlocks ? [
          {
            index: -1,
            type: 'page_header',
            bbox: [72, 28, 540, 44],
            lines: [{ bbox: [72, 28, 540, 44], spans: [{ type: 'text', content: 'Fixture running header' }] }]
          },
          {
            index: 100,
            type: 'page_footer',
            bbox: [72, 732, 540, 748],
            lines: [{ bbox: [72, 732, 540, 748], spans: [{ type: 'text', content: 'Fixture ending footer' }] }]
          },
          {
            index: 101,
            type: 'page_number',
            bbox: [290, 758, 320, 778],
            lines: [{ bbox: [290, 758, 320, 778], spans: [{ type: 'text', content: '316' }] }]
          }
        ] : []
      }
    ]
  }
}

function createAlignmentRegressionLayoutFixture(): object {
  return {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [612, 792],
        para_blocks: [
          {
            index: 0,
            type: 'title',
            bbox: [72, 72, 400, 100],
            lines: [{ bbox: [72, 72, 400, 100], spans: [{ type: 'text', content: 'Alignment regression' }] }]
          },
          {
            index: 1,
            type: 'text',
            bbox: [72, 120, 540, 180],
            lines: [{
              bbox: [72, 120, 540, 180],
              spans: [{ type: 'text', content: 'The abstract explains what happens then and furthermore motivates the method.' }]
            }]
          },
          {
            index: 2,
            type: 'text',
            bbox: [72, 200, 300, 224],
            lines: [{ bbox: [72, 200, 300, 224], spans: [{ type: 'text', content: 'Keywords: operators' }] }]
          }
        ],
        discarded_blocks: []
      },
      {
        page_idx: 1,
        page_size: [612, 792],
        para_blocks: [
          {
            index: 0,
            type: 'text',
            bbox: [72, 72, 160, 96],
            lines: [{ bbox: [72, 72, 160, 96], spans: [{ type: 'text', content: 'Then' }] }]
          },
          {
            index: 1,
            type: 'text',
            bbox: [72, 112, 360, 136],
            lines: [{ bbox: [72, 112, 360, 136], spans: [{ type: 'text', content: 'First equation explanation.' }] }]
          },
          {
            index: 2,
            type: 'text',
            bbox: [72, 152, 220, 176],
            lines: [{ bbox: [72, 152, 220, 176], spans: [{ type: 'text', content: 'Furthermore,' }] }]
          },
          {
            index: 3,
            type: 'text',
            bbox: [72, 192, 220, 216],
            lines: [{ bbox: [72, 192, 220, 216], spans: [{ type: 'text', content: 'Furthermore,' }] }]
          }
        ],
        discarded_blocks: []
      }
    ]
  }
}

function createTwoPagePdf(): Buffer {
  const stream1 = 'BT /F1 24 Tf 72 720 Td (Page One) Tj ET'
  const stream2 = 'BT /F1 24 Tf 72 720 Td (Page Two) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream1)} >>\nstream\n${stream1}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${Buffer.byteLength(stream2)} >>\nstream\n${stream2}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf)
}
