import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const PING_TIMEOUT = 30_000

export interface ServerPersistence {
  bindState: (docName: string, doc: Y.Doc) => void | Promise<void>
  writeState: (docName: string, doc: Y.Doc) => void | Promise<void>
}

let persistence: ServerPersistence | null = null

export function setPersistence(next: ServerPersistence | null): void {
  persistence = next
}

export class SharedDoc extends Y.Doc {
  readonly name: string
  readonly conns = new Map<WebSocket, Set<number>>()
  readonly awareness: awarenessProtocol.Awareness

  constructor(name: string, gc = true) {
    super({ gc })
    this.name = name
    this.awareness = new awarenessProtocol.Awareness(this)
    this.awareness.setLocalState(null)
    this.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = added.concat(updated, removed)
        if (origin !== null) {
          const controlled = this.conns.get(origin as WebSocket)
          if (controlled) {
            for (const id of added) controlled.add(id)
            for (const id of removed) controlled.delete(id)
          }
        }
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed))
        const buff = encoding.toUint8Array(encoder)
        for (const conn of this.conns.keys()) send(this, conn, buff)
      },
    )
    this.on('update', (update: Uint8Array) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      const message = encoding.toUint8Array(encoder)
      for (const conn of this.conns.keys()) send(this, conn, message)
    })
  }
}

const docs = new Map<string, SharedDoc>()

export function getYDoc(name: string, gc = true): SharedDoc {
  let doc = docs.get(name)
  if (!doc) {
    doc = new SharedDoc(name, gc)
    docs.set(name, doc)
    if (persistence) void persistence.bindState(name, doc)
  }
  return doc
}

function send(doc: SharedDoc, conn: WebSocket, message: Uint8Array): void {
  if (conn.readyState !== 0 && conn.readyState !== 1) {
    closeConn(doc, conn)
    return
  }
  try {
    conn.send(message, {}, (err) => {
      if (err) closeConn(doc, conn)
    })
  } catch {
    closeConn(doc, conn)
  }
}

function messageListener(conn: WebSocket, doc: SharedDoc, message: ArrayBuffer): void {
  try {
    const encoder = encoding.createEncoder()
    const decoder = decoding.createDecoder(new Uint8Array(message))
    const messageType = decoding.readVarUint(decoder)
    if (messageType === MESSAGE_SYNC) {
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.readSyncMessage(decoder, encoder, doc, conn)
      if (encoding.length(encoder) > 1) send(doc, conn, encoding.toUint8Array(encoder))
    } else if (messageType === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(decoder), conn)
    }
  } catch (error) {
    console.error('[sync] message error', error)
  }
}

function closeConn(doc: SharedDoc, conn: WebSocket): void {
  if (!doc.conns.has(conn)) {
    conn.close()
    return
  }
  const controlled = doc.conns.get(conn) ?? new Set<number>()
  doc.conns.delete(conn)
  awarenessProtocol.removeAwarenessStates(doc.awareness, [...controlled], null)
  if (doc.conns.size === 0 && persistence) {
    void Promise.resolve(persistence.writeState(doc.name, doc))
      .catch((error) => console.error('[persist] write failed', error))
      .finally(() => {
        doc.destroy()
        docs.delete(doc.name)
      })
  }
  conn.close()
}

export function setupWSConnection(conn: WebSocket, _req: IncomingMessage, docName: string): void {
  conn.binaryType = 'arraybuffer'
  const doc = getYDoc(docName)
  doc.conns.set(conn, new Set())

  conn.on('message', (message: ArrayBuffer | Buffer) => {
    const buffer = message instanceof ArrayBuffer ? message : message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength)
    messageListener(conn, doc, buffer as ArrayBuffer)
  })

  let pongReceived = true
  const pingInterval = setInterval(() => {
    if (!doc.conns.has(conn)) {
      clearInterval(pingInterval)
      return
    }
    if (!pongReceived) {
      closeConn(doc, conn)
      clearInterval(pingInterval)
      return
    }
    pongReceived = false
    try {
      conn.ping()
    } catch {
      closeConn(doc, conn)
      clearInterval(pingInterval)
    }
  }, PING_TIMEOUT)

  conn.on('close', () => {
    closeConn(doc, conn)
    clearInterval(pingInterval)
  })
  conn.on('pong', () => {
    pongReceived = true
  })

  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeSyncStep1(encoder, doc)
  send(doc, conn, encoding.toUint8Array(encoder))

  const states = doc.awareness.getStates()
  if (states.size > 0) {
    const awarenessEncoder = encoding.createEncoder()
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(doc.awareness, [...states.keys()]),
    )
    send(doc, conn, encoding.toUint8Array(awarenessEncoder))
  }
}

export async function flushAllDocs(): Promise<void> {
  if (!persistence) return
  await Promise.all(
    [...docs.values()].map((doc) =>
      Promise.resolve(persistence!.writeState(doc.name, doc)).catch((error) =>
        console.error('[persist] flush failed', error),
      ),
    ),
  )
}
