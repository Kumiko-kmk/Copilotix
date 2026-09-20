/**
 * Type-only facade for the RAG wire contracts.
 *
 * `ragSchemas.ts` is the single source of truth: every wire type is inferred
 * from its Zod schema there.  Keep this module type-only so consumers that
 * only need DTO shapes do not accidentally import schema values at runtime.
 */
export type * from './ragSchemas'
