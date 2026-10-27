import { PDFDocument } from 'pdf-lib'
import { MAX_PDF_BYTES } from '../contract/pdfLimits'
import { MAX_PDF_CROP_BYTES } from '../contract/pdfImport'
import { CoreUtilityOperationError } from '@platform/rpc/utility/coreUtilityRuntime'

/**
 * Returns the PDF without its first page, for cover sheets that repositories put in front of a
 * paper. The rest of the document (page objects, outlines, metadata) is carried over by pdf-lib;
 * nothing is written here, so the caller publishes the bytes atomically.
 */
export async function withoutFirstPage(source: Uint8Array): Promise<Uint8Array> {
  if (source.byteLength > MAX_PDF_CROP_BYTES) {
    throw new CoreUtilityOperationError('CORE_PDF_REWRITE_FAILED', 'PDF is too large to rewrite', false)
  }
  if (!/%PDF-\d\.\d/u.test(Buffer.from(source.subarray(0, 1024)).toString('latin1'))) {
    throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Invalid PDF header', false)
  }
  let output: Uint8Array
  try {
    // Encrypted files are rejected by pdf-lib: rewriting them would drop their protection.
    const document = await PDFDocument.load(source, { updateMetadata: false })
    if (document.getPageCount() < 2) throw new Error('A single-page PDF has no page to spare')
    document.removePage(0)
    output = await document.save()
  } catch (error) {
    if (error instanceof CoreUtilityOperationError) throw error
    throw new CoreUtilityOperationError('CORE_PDF_REWRITE_FAILED', 'The first PDF page could not be removed', false)
  }
  if (output.byteLength === 0 || output.byteLength > MAX_PDF_BYTES) {
    throw new CoreUtilityOperationError('CORE_PDF_REWRITE_FAILED', 'The rewritten PDF exceeds the supported size limit', false)
  }
  return output
}
