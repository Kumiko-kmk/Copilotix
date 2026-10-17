import { expect, it, vi } from 'vitest'
vi.mock('../src/renderer/pdfDocumentCache', () => ({ acquirePdfDocument: vi.fn() }))
import { loadDetailPage, type DetailPage } from '../src/renderer/paperArchive/detailPage'

it('reopens a cancelled cover without letting its late rejection evict the replacement', async () => {
  const controller = new AbortController()
  let rejectOld!: (error: Error) => void
  const old = loadDetailPage('cancel-reopen', () => new Promise((_, reject) => { rejectOld = reject }), controller.signal)
  controller.abort()
  const page = { canvas: {} as HTMLCanvasElement, pages: 3 } satisfies DetailPage
  const replacement = vi.fn(async () => page)
  await expect(loadDetailPage('cancel-reopen', replacement)).resolves.toBe(page)
  rejectOld(new Error('cancelled render'))
  await expect(old).rejects.toThrow('cancelled render')
  await expect(loadDetailPage('cancel-reopen', replacement)).resolves.toBe(page)
  expect(replacement).toHaveBeenCalledTimes(1)
})

it('retains a completed cover after its view closes', async () => {
  const controller = new AbortController()
  const page = { canvas: {} as HTMLCanvasElement, pages: 2 } satisfies DetailPage
  const render = vi.fn(async () => page)
  await expect(loadDetailPage('completed-cover', render, controller.signal)).resolves.toBe(page)
  controller.abort()
  await expect(loadDetailPage('completed-cover', render)).resolves.toBe(page)
  expect(render).toHaveBeenCalledTimes(1)
})
