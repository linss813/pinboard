import { promises as fs } from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { setPersistence } from './sync'

const DEBOUNCE_MS = 800

const timers = new Map<string, NodeJS.Timeout>()
const writeQueues = new Map<string, Promise<void>>()

function dataDir(): string {
  return path.resolve(process.env.DATA_DIR || 'data')
}

function roomsDir(): string {
  return path.join(dataDir(), 'rooms')
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

function roomFile(roomId: string): string {
  return path.join(roomsDir(), `${roomId}.bin`)
}

async function readState(roomId: string): Promise<Uint8Array | null> {
  try {
    const buf = await fs.readFile(roomFile(roomId))
    return new Uint8Array(buf)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[persist] read failed', roomId, error)
    }
    return null
  }
}

async function writeStateNow(roomId: string, doc: Y.Doc): Promise<void> {
  const previous = writeQueues.get(roomId) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const state = Y.encodeStateAsUpdate(doc)
      await ensureDir(roomsDir())
      const target = roomFile(roomId)
      const temp = `${target}.${process.pid}.tmp`
      await fs.writeFile(temp, state)
      await fs.rename(temp, target)
    })
    .catch((error) => {
      console.error('[persist] write failed', roomId, error)
    })
    .finally(() => {
      if (writeQueues.get(roomId) === next) writeQueues.delete(roomId)
    })
  writeQueues.set(roomId, next)
  await next
}

function scheduleWrite(roomId: string, doc: Y.Doc): void {
  const existing = timers.get(roomId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    timers.delete(roomId)
    void writeStateNow(roomId, doc)
  }, DEBOUNCE_MS)
  timers.set(roomId, timer)
}

export function installFilePersistence(): void {
  setPersistence({
    bindState: async (roomId, doc) => {
      const state = await readState(roomId)
      if (state) {
        try {
          Y.applyUpdate(doc, state, 'disk')
        } catch (error) {
          console.error('[persist] invalid state', roomId, error)
        }
      }
      doc.on('update', (_update: Uint8Array, origin: unknown) => {
        if (origin === 'disk') return
        scheduleWrite(roomId, doc)
      })
    },
    writeState: async (roomId, doc) => {
      const timer = timers.get(roomId)
      if (timer) {
        clearTimeout(timer)
        timers.delete(roomId)
      }
      await writeStateNow(roomId, doc)
    },
  })
}

export function dataPaths(): { dataDir: string; roomsDir: string; assetsDir: string } {
  return {
    dataDir: dataDir(),
    roomsDir: roomsDir(),
    assetsDir: path.join(dataDir(), 'assets'),
  }
}
