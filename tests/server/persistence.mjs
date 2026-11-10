import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const port = 4321
const dataDir = await mkdtemp(path.join(tmpdir(), 'pinboard-persist-'))
const room = 'svr-' + randomBytes(10).toString('base64url')
let server

function startServer() {
  server = spawn(process.execPath, ['server-dist/index.cjs'], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', (d) => process.stdout.write('[server] ' + d))
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d))
}

async function waitHealth() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (res.ok) return
    } catch {
      // server still starting
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('server did not become healthy')
}

function connect(doc) {
  return new WebsocketProvider(`ws://127.0.0.1:${port}/ws`, room, doc, { WebSocketPolyfill: WebSocket })
}

function waitSync(provider, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sync timeout')), timeout)
    provider.on('sync', (synced) => {
      if (synced) {
        clearTimeout(timer)
        resolve()
      }
    })
    if (provider.synced) {
      clearTimeout(timer)
      resolve()
    }
  })
}

try {
  startServer()
  await waitHealth()
  const docA = new Y.Doc()
  const providerA = connect(docA)
  await waitSync(providerA)
  docA.getMap('items').set('persisted', 'yes')
  await new Promise((r) => setTimeout(r, 300))
  providerA.destroy()
  docA.destroy()
  await new Promise((r) => setTimeout(r, 1200))
  server.kill('SIGTERM')
  await new Promise((r) => server.once('exit', r))

  startServer()
  await waitHealth()
  const docB = new Y.Doc()
  const providerB = connect(docB)
  await waitSync(providerB)
  await new Promise((r) => setTimeout(r, 300))
  const value = docB.getMap('items').get('persisted')
  if (value !== 'yes') throw new Error(`persistence failed, got ${String(value)}`)
  console.log('SERVER PERSISTENCE PASSED', { room, value })
  providerB.destroy()
  docB.destroy()
  server.kill('SIGTERM')
  await new Promise((r) => server.once('exit', r))
} finally {
  if (server && !server.killed) server.kill('SIGTERM')
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
}
