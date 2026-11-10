import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  rootDir: string,
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const url = new URL(req.url || '/', 'http://localhost')
  const decoded = decodeURIComponent(url.pathname)
  let rel = decoded.replace(/^\/+/, '')
  if (!rel) rel = 'index.html'
  const root = path.resolve(rootDir)
  let target = path.resolve(root, rel)
  if (!target.startsWith(root + path.sep) && target !== root) return false

  let stat
  try {
    stat = await fs.stat(target)
  } catch {
    if (!path.extname(rel)) {
      target = path.join(root, 'index.html')
      try {
        stat = await fs.stat(target)
      } catch {
        return false
      }
    } else {
      return false
    }
  }

  if (stat.isDirectory()) {
    target = path.join(target, 'index.html')
    try {
      stat = await fs.stat(target)
    } catch {
      return false
    }
  }

  const ext = path.extname(target).toLowerCase()
  const isIndex = path.basename(target) === 'index.html'
  const immutable = url.pathname.startsWith('/assets/')
  const headers: Record<string, string | number> = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': isIndex ? 'no-cache' : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  const { createReadStream } = await import('node:fs')
  createReadStream(target).pipe(res)
  return true
}
