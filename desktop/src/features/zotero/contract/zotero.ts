import { z } from 'zod'

/**
 * Zotero bridge (see docs/ZOTERO_BRIDGE_ZH.md). Main reads the local Zotero library read-only,
 * either through Zotero's local API or a copy of zotero.sqlite, and keeps the result as an
 * in-memory snapshot. The renderer only ever sees keys and display text; file paths stay in Main.
 */
export const ZOTERO_ITEMS_PAGE_SIZE = 200
export const ZOTERO_IMPORT_MAX = 500

const zoteroKey = z.string().regex(/^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/u)

export const zoteroSourceSchema = z.enum(['local-api', 'sqlite'])

export const zoteroCollectionSchema = z.object({
  key: zoteroKey,
  name: z.string().max(1_000),
  parentKey: zoteroKey.nullable(),
  itemCount: z.number().int().min(0)
}).strict()

export const zoteroCatalogSchema = z.object({
  snapshotId: z.string().uuid(),
  source: zoteroSourceSchema,
  /** Why the local API was not used, when the snapshot came from zotero.sqlite. */
  fallbackReason: z.string().max(500).nullable(),
  libraryID: z.number().int().positive(),
  collections: z.array(zoteroCollectionSchema).max(10_000),
  totalItems: z.number().int().min(0),
  unfiledItems: z.number().int().min(0)
}).strict()

export const zoteroCatalogRequestSchema = z.object({ refresh: z.boolean().optional() }).strict()

/** `collectionKey` null lists the whole library, 'unfiled' the items in no collection. */
export const zoteroItemsRequestSchema = z.object({
  snapshotId: z.string().uuid(),
  collectionKey: z.union([zoteroKey, z.literal('unfiled')]).nullable(),
  query: z.string().max(200).optional(),
  after: z.number().int().min(0).optional()
}).strict()

export const zoteroItemSchema = z.object({
  itemKey: zoteroKey,
  title: z.string().max(2_000),
  creators: z.string().max(500),
  year: z.string().max(16).nullable(),
  itemType: z.string().max(64),
  /** The PDF that would be imported: the first PDF attachment, or the item itself when it is a top-level PDF. */
  attachmentKey: zoteroKey.nullable(),
  pdfCount: z.number().int().min(0),
  importedDocumentId: z.string().uuid().nullable()
}).strict()

export const zoteroItemsPageSchema = z.object({
  items: z.array(zoteroItemSchema).max(ZOTERO_ITEMS_PAGE_SIZE),
  next: z.number().int().min(0).nullable(),
  total: z.number().int().min(0)
}).strict()

export const zoteroImportRequestSchema = z.object({
  snapshotId: z.string().uuid(),
  itemKeys: z.array(zoteroKey).min(1).max(ZOTERO_IMPORT_MAX)
}).strict()

export const zoteroImportResultSchema = z.object({
  created: z.number().int().min(0),
  /** Already in the library (same PDF hash); the Zotero link was added to the existing paper. */
  linked: z.number().int().min(0),
  failed: z.array(z.object({ name: z.string().max(2_000), message: z.string().max(2_000) }).strict()).max(ZOTERO_IMPORT_MAX)
}).strict()

/** `<document>/zotero/link.v1.json`: the Zotero items whose PDF became this paper. */
export const zoteroLinkSchema = z.object({
  libraryID: z.number().int().positive(),
  /** Zotero group ID for group libraries; null for "My Library". */
  groupID: z.number().int().positive().nullable(),
  itemKey: zoteroKey,
  attachmentKey: zoteroKey,
  linkedAt: z.string().datetime()
}).strict()

export const zoteroLinkFileSchema = z.object({
  version: z.literal(1),
  links: z.array(zoteroLinkSchema).max(64)
}).strict()

export const ZOTERO_EXPORT_MAX = 50

export const zoteroExportRequestSchema = z.object({
  documentIds: z.array(z.string().uuid()).min(1).max(ZOTERO_EXPORT_MAX),
  /** Export papers that were already exported once; otherwise they are reported in `skipped`. */
  repeat: z.boolean().optional()
}).strict()

export const zoteroExportResultSchema = z.object({
  /** Papers linked to a Zotero item: a standalone note with a link back to that item. */
  notes: z.number().int().min(0),
  /** Other papers: a new Zotero item with the PDF and a child note. */
  items: z.number().int().min(0),
  skipped: z.array(z.string().uuid()).max(ZOTERO_EXPORT_MAX),
  failed: z.array(z.object({ name: z.string().max(2_000), message: z.string().max(2_000) }).strict()).max(ZOTERO_EXPORT_MAX)
}).strict()

/** `<document>/zotero/export.v1.json`: when this paper was sent to Zotero, so a repeat is a choice. */
export const zoteroExportRecordSchema = z.object({
  version: z.literal(1),
  exports: z.array(z.object({
    kind: z.enum(['note', 'item']),
    exportedAt: z.string().datetime()
  }).strict()).max(64)
}).strict()

export type ZoteroSource = z.infer<typeof zoteroSourceSchema>
export type ZoteroCollection = z.infer<typeof zoteroCollectionSchema>
export type ZoteroCatalog = z.infer<typeof zoteroCatalogSchema>
export type ZoteroCatalogRequest = z.infer<typeof zoteroCatalogRequestSchema>
export type ZoteroItemsRequest = z.infer<typeof zoteroItemsRequestSchema>
export type ZoteroItem = z.infer<typeof zoteroItemSchema>
export type ZoteroItemsPage = z.infer<typeof zoteroItemsPageSchema>
export type ZoteroImportRequest = z.infer<typeof zoteroImportRequestSchema>
export type ZoteroImportResult = z.infer<typeof zoteroImportResultSchema>
export type ZoteroLink = z.infer<typeof zoteroLinkSchema>
export type ZoteroLinkFile = z.infer<typeof zoteroLinkFileSchema>
export type ZoteroExportRequest = z.infer<typeof zoteroExportRequestSchema>
export type ZoteroExportResult = z.infer<typeof zoteroExportResultSchema>
export type ZoteroExportRecord = z.infer<typeof zoteroExportRecordSchema>

export interface ZoteroDesktopApi {
  catalog(request: ZoteroCatalogRequest): Promise<ZoteroCatalog>
  items(request: ZoteroItemsRequest): Promise<ZoteroItemsPage>
  importItems(request: ZoteroImportRequest): Promise<ZoteroImportResult>
  exportDocuments(request: ZoteroExportRequest): Promise<ZoteroExportResult>
}
