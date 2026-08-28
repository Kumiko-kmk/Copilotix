import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'

type AssetResolver = (taskId: string, assetPath: string) => string

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
}

export async function createAssetResponse(request: Request, resolveAsset: AssetResolver): Promise<Response> {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range'
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { ...corsHeaders, Allow: 'GET, HEAD, OPTIONS' } })
  }

  try {
    const url = new URL(request.url)
    const filePath = resolveAsset(url.hostname, url.pathname)
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) return new Response('Not found', { status: 404, headers: corsHeaders })

    const commonHeaders: Record<string, string> = {
      ...corsHeaders,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    }
    const rangeHeader = request.headers.get('range')
    if (!rangeHeader) {
      commonHeaders['Content-Length'] = String(fileStat.size)
      const body = request.method === 'HEAD' ? null : toWebStream(createReadStream(filePath))
      return new Response(body, { status: 200, headers: commonHeaders })
    }

    const range = parseRange(rangeHeader, fileStat.size)
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: { ...commonHeaders, 'Content-Range': `bytes */${fileStat.size}`, 'Content-Length': '0' }
      })
    }
    const length = range.end - range.start + 1
    const headers = {
      ...commonHeaders,
      'Content-Length': String(length),
      'Content-Range': `bytes ${range.start}-${range.end}/${fileStat.size}`
    }
    const body = request.method === 'HEAD' ? null : toWebStream(createReadStream(filePath, range))
    return new Response(body, { status: 206, headers })
  } catch {
    return new Response('Not found', { status: 404, headers: corsHeaders })
  }
}

export function parseRange(value: string, size: number): { start: number; end: number } | null {
  if (size <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || (!match[1] && !match[2])) return null
  let start: number
  let end: number
  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null
    start = Math.max(0, size - suffixLength)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null
  return { start, end: Math.min(end, size - 1) }
}

function toWebStream(stream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>
}
