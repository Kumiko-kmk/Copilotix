import { DatabaseSync } from 'node:sqlite'
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'

export interface E2EWorkspace {
  root: string
  userData: string
  env: NodeJS.ProcessEnv
  cleanup(): Promise<void>
}

export async function createE2EWorkspace(): Promise<E2EWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'mineru-e2e-'))
  const userData = join(root, 'user-data')
  await mkdir(userData, { recursive: true })
  return {
    root,
    userData,
    env: { ...process.env, NODE_ENV: 'test', MINERU_E2E_USER_DATA: userData },
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

export async function seedReaderTask(
  workspace: E2EWorkspace,
  options?: { missingPdf?: boolean; sourcePdf?: string }
): Promise<string> {
  const taskId = options?.missingPdf ? 'missing-pdf-task' : options?.sourcePdf ? 'real-pdf-task' : 'reader-pdf-task'
  const outputDir = join(workspace.root, taskId)
  const pdfPath = join(outputDir, 'original.pdf')
  await mkdir(outputDir, { recursive: true })
  if (options?.sourcePdf) await copyFile(options.sourcePdf, pdfPath)
  else if (!options?.missingPdf) await writeFile(pdfPath, createTwoPagePdf())
  await writeFile(join(outputDir, 'full.md'), '# Fixture document\n\nFirst page.', 'utf8')

  const database = new DatabaseSync(join(workspace.userData, 'mineru-desktop.sqlite3'))
  database.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      output_dir TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      parser_model TEXT NOT NULL,
      translation_provider TEXT NOT NULL,
      remote_batch_id TEXT,
      remote_data_id TEXT,
      remote_result_url TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  const now = new Date().toISOString()
  database.prepare(`
    INSERT INTO tasks(
      id,name,source_path,source_hash,output_dir,status,progress,parser_model,
      translation_provider,remote_batch_id,remote_data_id,remote_result_url,error,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    taskId,
    options?.missingPdf ? 'missing.pdf' : options?.sourcePdf ? basename(options.sourcePdf) : 'fixture.pdf',
    pdfPath,
    'fixture-hash',
    outputDir,
    'failed',
    0,
    'vlm',
    'qwen',
    null,
    null,
    null,
    options?.missingPdf ? 'fixture missing file' : 'fixture task',
    now,
    now
  )
  database.close()
  return taskId
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
