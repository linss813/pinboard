import http from 'node:http'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { ROOM_ID_RE } from '../shared/constants'
import { handleAssetGet, handleAssetUpload } from './assets'
import { json, notFound, text } from './http'
import { installFilePersistence } from './persistence'
import { serveStatic } from './static'
import { flushAllDocs, setupWSConnection } from './sync'

try {
  process.loadEnvFile?.('.env')
} catch {
  // .env is optional
}

const PORT = Number(process.env.PORT || (process.env.NODE_ENV === 'production' ? 18016 : 1234))
const HOST = process.env.HOST || '0.0.0.0'
const WEB_DIST = path.resolve(process.env.WEB_DIST || 'dist')
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

installFilePersistence()

function originAllowed(req: http.IncomingMessage): boolean {
  if (ALLOWED_ORIGINS.size === 0) return true
  const origin = req.headers.origin
  return !origin || ALLOWED_ORIGINS.has(origin)
}

const assetRoute = /^\/api\/rooms\/([^/]+)\/assets(?:\/([a-f0-9]{64}))?\/?$/

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost')
  const { pathname } = url

  if (pathname === '/healthz') {
    json(res, 200, { ok: true, uptime: Math.round(process.uptime()) })
    return
  }

  if (pathname.startsWith('/api/')) {
    const match = assetRoute.exec(pathname)
    if (match) {
      const roomId = decodeURIComponent(match[1])
      const assetId = match[2]
      if (!ROOM_ID_RE.test(roomId)) {
        json(res, 400, { error: 'invalid room' })
        return
      }
      if (!assetId && req.method === 'POST') {
        await handleAssetUpload(req, res, roomId)
        return
      }
      if (assetId && (req.method === 'GET' || req.method === 'HEAD')) {
        await handleAssetGet(req, res, roomId, assetId)
        return
      }
      json(res, 405, { error: 'method not allowed' })
      return
    }
    notFound(res)
    return
  }

  if (await serveStatic(req, res, WEB_DIST)) return
  if (req.method === 'GET') {
    text(res, 404, 'Web client not built. Run `npm run dev` for development or `npm run build` first.')
  } else {
    notFound(res)
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  void handleRequest(req, res).catch((error) => {
    console.error('[http] request failed', error)
    if (!res.headersSent) json(res, 500, { error: 'internal error' })
    else res.end()
  })
})

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 8 * 1024 * 1024,
  perMessageDeflate: false,
})

server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const pathname = decodeURIComponent(url.pathname)
  if (!pathname.startsWith('/ws/')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  const roomId = pathname.slice('/ws/'.length).split('/')[0]
  if (!ROOM_ID_RE.test(roomId)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }
  if (!originAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req)
    setupWSConnection(ws, req, roomId)
  })
})

wss.on('connection', (ws) => {
  ws.on('error', (error) => console.error('[ws] connection error', error))
})

server.listen(PORT, HOST, () => {
  console.log(`[pinboard] sync server listening on http://${HOST}:${PORT}`)
  if (process.env.NODE_ENV !== 'production') {
    console.log('[pinboard] development web client: http://localhost:5173')
  }
})

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[pinboard] shutting down (${signal})`)
  wss.clients.forEach((ws) => ws.close(1001, 'server shutdown'))
  wss.close()
  try {
    await flushAllDocs()
  } catch (error) {
    console.error('[pinboard] flush failed', error)
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3500).unref()
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('uncaughtException', (error) => {
  console.error('[pinboard] uncaught exception', error)
})
process.on('unhandledRejection', (error) => {
  console.error('[pinboard] unhandled rejection', error)
})
