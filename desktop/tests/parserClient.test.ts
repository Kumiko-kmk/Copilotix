import { describe, expect, it } from 'vitest'
import { isInsecurePublicUrl, normalizeBaseUrl } from '@main/parserClient'

describe('parser URL policy', () => {
  it('normalizes supported HTTP URLs', () => {
    expect(normalizeBaseUrl(' http://127.0.0.1:8000/ ')).toBe('http://127.0.0.1:8000')
  })

  it('warns only for public cleartext hosts', () => {
    expect(isInsecurePublicUrl('http://example.com')).toBe(true)
    expect(isInsecurePublicUrl('http://192.168.1.20:8000')).toBe(false)
    expect(isInsecurePublicUrl('https://example.com')).toBe(false)
  })
})
