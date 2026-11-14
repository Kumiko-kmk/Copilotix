import { z } from 'zod'

/** Field validators shared by the IPC schemas of every module: bounded, NUL-free strings. */
export const noNul = (value: string): boolean => !value.includes('\0')
export const hasControlCharacters = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}
export const boundedId = z.string().min(1).max(512).refine(noNul, '值不能包含 NUL 字符')
export const boundedPath = z.string().min(1).max(32_768).refine(noNul, '路径不能包含 NUL 字符')
export const safeName = z.string().min(1).max(32_768).refine(noNul, '名称不能包含 NUL 字符')
export const timestamp = z.string().min(1).max(128)

/** Document identifiers and texts crossing IPC; no local filesystem path is part of a document contract. */
export const uuid = z.string().uuid().refine(noNul, '值不能包含 NUL 字符')
export const documentFilename = z.string().min(1).max(1_024).refine(noNul, '文件名不能包含 NUL 字符')
export const documentContent = z.string().max(100_000_000).refine(noNul, '内容不能包含 NUL 字符')
export const documentUrl = z.string().min(1).max(8_192).refine(noNul, '地址不能包含 NUL 字符')
export const documentTimestamp = z.string().min(1).max(128).refine(noNul, '时间不能包含 NUL 字符')
export const documentProgress = z.number().int().min(0).max(100)
