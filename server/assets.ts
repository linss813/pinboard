import { promises as fs, createReadStream } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ASSET_ID_RE, IMAGE_MIME_WHITELIST, MAX_IMAGE_BYTES, ROOM_ID_RE } from '../shared/constants'
import { dataPaths } from './persistence'
import { json, notFound, readBody } from './http'

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

function sniffMime(buf: Uint8Array): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

function extForMime(mime: string): string {
  return mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] ?? 'bin'
}

async function roomAssetDir(roomId: string): Promise<string> {
  const dir = path.join(dataPaths().assetsDir, roomId)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export async function handleAssetUpload(req: IncomingMessage, res: ServerResponse, roomId: string): Promise<void> {
  if (!ROOM_ID_RE.test(roomId)) {
    json(res, 400, { error: 'invalid room' })
    return
  }
  const declared = Number(req.headers['content-length'] || 0)
  if (declared > MAX_IMAGE_BYTES) {
    json(res, 413, { error: 'image too large' })
    req.destroy()
    return
  }
  let body: Uint8Array
  try {
    body = await readBody(req, MAX_IMAGE_BYTES)
  } catch (error) {
    json(res, 413, { error: (error as Error).message })
    return
  }
  if (!body.length) {
    json(res, 400, { error: 'empty body' })
    return
  }
  const mime = sniffMime(body)
  if (!mime || !IMAGE_MIME_WHITELIST.includes(mime as (typeof IMAGE_MIME_WHITELIST)[number])) {
    json(res, 415, { error: 'unsupported image type' })
    return
  }
  const hash = createHash('sha256').update(body).digest('hex')
  const dir = await roomAssetDir(roomId)
  const file = path.join(dir, `${hash}.${extForMime(mime)}`)
  const metaFile = path.join(dir, `${hash}.json`)
  try {
    await fs.access(file)
  } catch {
    const temp = path.join(dir, `${hash}.${process.pid}.tmp`)
    await fs.writeFile(temp, body)
    await fs.rename(temp, file)
    await fs.writeFile(metaFile, JSON.stringify({ mime, size: body.length, createdAt: Date.now() }))
  }
  json(res, 200, { id: hash, mime, size: body.length, url: assetUrl(roomId, hash) })
}

export async function handleAssetGet(
  _req: IncomingMessage,
  res: ServerResponse,
  roomId: string,
  assetId: string,
): Promise<void> {
  if (!ROOM_ID_RE.test(roomId) || !ASSET_ID_RE.test(assetId)) {
    notFound(res)
    return
  }
  const dir = path.join(dataPaths().assetsDir, roomId)
  const knownMimes = new Set(Object.values(MIME_BY_EXT))
  let mime: string | null = null
  let filePath: string | null = null
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, `${assetId}.json`), 'utf8')) as { mime?: string }
    if (typeof meta.mime === 'string' && knownMimes.has(meta.mime)) mime = meta.mime
  } catch {
    // fall back to locating the file by extension
  }
  for (const m of Object.keys(MIME_BY_EXT)) {
    const candidate = path.join(dir, `${assetId}.${m}`)
    try {
      await fs.access(candidate)
      filePath = candidate
      mime = mime ?? MIME_BY_EXT[m]
      break
    } catch {
      // keep looking
    }
  }
  if (!filePath) {
    notFound(res)
    return
  }
  try {
    const stat = await fs.stat(filePath)
    res.writeHead(200, {
      'Content-Type': mime ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    })
    createReadStream(filePath).pipe(res)
  } catch {
    notFound(res)
  }
}

function assetUrl(roomId: string, assetId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/assets/${assetId}`
}
