import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { IndexeddbPersistence } from 'y-indexeddb'
import type { Awareness } from 'y-protocols/awareness'
import type { LaserTrail, PeerCursor } from './scene'
import type { Point, PresenceState, PeerUser, ReactionEvent } from '../shared/types'
import { t } from './i18n'
import { pickUserColor, uuid } from './util'

const CURSOR_THROTTLE = 45
const VIEW_THROTTLE = 220
const LASER_THROTTLE = 32
const REACTION_THROTTLE = 45
const LASER_TTL = 900

interface PeerSnapshot {
  clientId: number
  state: PresenceState
  user: PeerUser
}

export type { PeerSnapshot }

export interface PresenceCallbacks {
  onChange: () => void
  onPeerList: (peers: PeerSnapshot[]) => void
  onReaction: (reaction: ReactionEvent, color: string) => void
  onStatus: (status: 'connecting' | 'connected' | 'disconnected') => void
  onSync: (synced: boolean) => void
  onLocalPersisted: () => void
}

function wsUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}/ws`
}

export function storedName(): string {
  try {
    return localStorage.getItem('pinboard-name') || ''
  } catch {
    return ''
  }
}

export function storeName(name: string): void {
  try {
    localStorage.setItem('pinboard-name', name)
  } catch {
    // ignore storage errors
  }
}

export class PresenceManager {
  readonly id: string
  readonly color: string
  readonly provider: WebsocketProvider
  readonly awareness: Awareness
  readonly localPersistence: IndexeddbPersistence
  name: string

  private peers: PeerSnapshot[] = []
  private peerSignature = ''
  private cursorTimer: ReturnType<typeof setTimeout> | null = null
  private pendingCursor: Point | null | undefined
  private lastCursorSent = 0
  private lastViewSent = 0
  private viewTimer: ReturnType<typeof setTimeout> | null = null
  private pendingView: { cx: number; cy: number; scale: number } | null = null
  private lastLaserSent = 0
  private lastReactionSent = 0
  private pendingReaction: ReactionEvent | null = null
  private reactionTimer: ReturnType<typeof setTimeout> | null = null
  private lastReactionSignatures = new Map<number, string>()
  private laserTrails = new Map<number, LaserTrail>()
  private lastLaserTs = new Map<number, number>()
  private awarenessHandler: (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void

  constructor(
    doc: Y.Doc,
    readonly roomId: string,
    private readonly callbacks: PresenceCallbacks,
  ) {
    let id = ''
    try {
      id = sessionStorage.getItem('pinboard-tab-user') || ''
      if (!id) {
        id = uuid()
        sessionStorage.setItem('pinboard-tab-user', id)
      }
    } catch {
      id = uuid()
    }
    this.id = id
    this.color = pickUserColor(id)
    this.name = storedName()

    this.provider = new WebsocketProvider(wsUrl(), roomId, doc, { connect: true })
    this.awareness = this.provider.awareness
    this.localPersistence = new IndexeddbPersistence(`pinboard-doc-${roomId}`, doc)

    if (this.name) this.publishUser(this.name)

    this.provider.on('status', ({ status }: { status: 'connecting' | 'connected' | 'disconnected' }) => {
      this.callbacks.onStatus(status)
    })
    this.provider.on('sync', (synced: boolean) => {
      this.callbacks.onSync(synced)
    })
    this.localPersistence.on('synced', () => this.callbacks.onLocalPersisted())

    this.awarenessHandler = (changes) => this.onAwareness(changes)
    this.awareness.on('change', this.awarenessHandler)
    this.refreshPeers()
  }

  get self(): PeerUser {
    return { id: this.id, name: this.name || t('avatar.guest'), color: this.color }
  }

  get currentPeers(): PeerCursor[] {
    return this.peers
      .filter((peer) => peer.state.user)
      .map((peer) => ({
        clientId: peer.clientId,
        user: peer.user,
        cursor: peer.state.cursor ?? null,
        selection: peer.state.selection ?? [],
        editingId: peer.state.editingId ?? null,
        view: peer.state.view,
        followId: peer.state.followingId ?? null,
      }))
  }

  get peerList(): PeerSnapshot[] {
    return this.peers
  }

  setUserName(name: string): void {
    const trimmed = name.trim().slice(0, 20) || t('avatar.guest')
    this.name = trimmed
    storeName(trimmed)
    this.publishUser(trimmed)
    this.refreshPeers()
  }

  setEphemeralName(name: string): void {
    const trimmed = name.trim().slice(0, 20) || t('avatar.guest')
    this.name = trimmed
    this.publishUser(trimmed)
    this.refreshPeers()
  }

  private publishUser(name: string): void {
    this.awareness.setLocalStateField('user', { id: this.id, name, color: this.color })
  }

  updateCursor(point: Point | null, immediate = false): void {
    this.pendingCursor = point
    const now = performance.now()
    if (immediate) {
      if (this.cursorTimer) clearTimeout(this.cursorTimer)
      this.cursorTimer = null
      this.lastCursorSent = now
      this.awareness.setLocalStateField('cursor', point)
      return
    }
    const elapsed = now - this.lastCursorSent
    if (elapsed >= CURSOR_THROTTLE) {
      this.lastCursorSent = now
      this.awareness.setLocalStateField('cursor', point)
    } else if (!this.cursorTimer) {
      this.cursorTimer = setTimeout(() => {
        this.cursorTimer = null
        this.lastCursorSent = performance.now()
        this.awareness.setLocalStateField('cursor', this.pendingCursor ?? null)
      }, CURSOR_THROTTLE - elapsed)
    }
  }

  setSelection(ids: string[]): void {
    this.awareness.setLocalStateField('selection', ids)
  }

  setEditingId(id: string | null): void {
    this.awareness.setLocalStateField('editingId', id)
  }

  setFollowing(userId: string | null): void {
    this.awareness.setLocalStateField('followingId', userId)
  }

  updateView(view: { cx: number; cy: number; scale: number }): void {
    this.pendingView = view
    const now = performance.now()
    const elapsed = now - this.lastViewSent
    if (elapsed >= VIEW_THROTTLE) {
      this.lastViewSent = now
      this.awareness.setLocalStateField('view', view)
    } else if (!this.viewTimer) {
      this.viewTimer = setTimeout(() => {
        this.viewTimer = null
        this.lastViewSent = performance.now()
        if (this.pendingView) this.awareness.setLocalStateField('view', this.pendingView)
      }, VIEW_THROTTLE - elapsed)
    }
  }

  sendLaser(point: Point | null): void {
    if (!point) {
      this.awareness.setLocalStateField('laser', null)
      return
    }
    if (!this.awareness.getLocalState()?.user) return
    const now = performance.now()
    if (now - this.lastLaserSent < LASER_THROTTLE) return
    this.lastLaserSent = now
    this.awareness.setLocalStateField('laser', { x: point.x, y: point.y, ts: Date.now() })
  }

  publishReaction(reaction: ReactionEvent): void {
    if (!this.awareness.getLocalState()?.user) return
    this.pendingReaction = reaction
    const now = performance.now()
    const elapsed = now - this.lastReactionSent
    if (elapsed >= REACTION_THROTTLE) {
      this.lastReactionSent = now
      this.awareness.setLocalStateField('reaction', reaction)
    } else if (!this.reactionTimer) {
      this.reactionTimer = setTimeout(() => {
        this.reactionTimer = null
        this.lastReactionSent = performance.now()
        if (this.pendingReaction) this.awareness.setLocalStateField('reaction', this.pendingReaction)
      }, REACTION_THROTTLE - elapsed)
    }
  }

  setViewpointTarget(userId: string): { user: PeerUser; view?: { cx: number; cy: number; scale: number }; cursor: Point | null } | null {
    const peer = this.peers.find((p) => p.user.id === userId)
    if (!peer) return null
    return { user: peer.user, view: peer.state.view, cursor: peer.state.cursor ?? null }
  }

  canFollow(userId: string): { ok: boolean; reason?: string; user?: PeerUser } {
    const peer = this.peers.find((p) => p.user.id === userId)
    if (!peer) return { ok: false, reason: t('follow.gone') }
    if (peer.state.followingId === this.id) return { ok: false, reason: t('follow.selfBlocked'), user: peer.user }
    return { ok: true, user: peer.user }
  }

  followedPeer(userId: string): PeerSnapshot | null {
    return this.peers.find((p) => p.user.id === userId) ?? null
  }

  pruneLasers(now: number): LaserTrail[] {
    for (const [clientId, trail] of this.laserTrails) {
      if (!this.peers.some((p) => p.clientId === clientId)) {
        this.laserTrails.delete(clientId)
        this.lastLaserTs.delete(clientId)
        continue
      }
      trail.points = trail.points.filter((p) => now - p.t < LASER_TTL)
      if (!trail.points.length) this.laserTrails.delete(clientId)
    }
    return [...this.laserTrails.values()]
  }

  retryConnection(): void {
    this.provider.connect()
  }

  destroy(): void {
    if (this.cursorTimer) clearTimeout(this.cursorTimer)
    if (this.viewTimer) clearTimeout(this.viewTimer)
    if (this.reactionTimer) clearTimeout(this.reactionTimer)
    this.awareness.off('change', this.awarenessHandler)
    this.awareness.setLocalState(null)
    this.localPersistence.destroy()
    this.provider.destroy()
  }

  private onAwareness(changes: { added: number[]; updated: number[]; removed: number[] }): void {
    const localId = this.awareness.clientID
    const addedClients = new Set(changes.added)
    for (const clientId of [...changes.added, ...changes.updated]) {
      if (clientId === localId) continue
      const state = this.awareness.getStates().get(clientId) as PresenceState | undefined
      if (!state) continue
      const user = state.user
      if (user && state.laser && typeof state.laser.x === 'number') {
        const lastTs = this.lastLaserTs.get(clientId) ?? 0
        if (state.laser.ts > lastTs) {
          this.lastLaserTs.set(clientId, state.laser.ts)
          let trail = this.laserTrails.get(clientId)
          if (!trail) {
            trail = { clientId, color: user.color, points: [] }
            this.laserTrails.set(clientId, trail)
          }
          trail.color = user.color
          trail.points.push({ x: state.laser.x, y: state.laser.y, t: performance.now() })
          if (trail.points.length > 40) trail.points.shift()
        }
      }
      if (user && state.reaction) {
        const reaction = state.reaction
        const signature = `${reaction.id}:${reaction.count ?? 1}:${reaction.ts}:${reaction.kind}`
        if (this.lastReactionSignatures.get(clientId) !== signature) {
          this.lastReactionSignatures.set(clientId, signature)
          // Skip reactions that are already present when we first learn about a peer.
          if (!addedClients.has(clientId)) {
            this.callbacks.onReaction(reaction, user.color)
          }
        }
      } else if (user) {
        this.lastReactionSignatures.delete(clientId)
      }
    }
    for (const clientId of changes.removed) {
      this.laserTrails.delete(clientId)
      this.lastLaserTs.delete(clientId)
      this.lastReactionSignatures.delete(clientId)
    }
    this.refreshPeers()
    this.callbacks.onChange()
  }

  private refreshPeers(): void {
    const states = this.awareness.getStates()
    const next: PeerSnapshot[] = []
    states.forEach((raw, clientId) => {
      if (clientId === this.awareness.clientID) return
      const state = raw as PresenceState
      if (!state.user) return
      next.push({ clientId, state, user: state.user })
    })
    next.sort((a, b) => a.user.name.localeCompare(b.user.name))
    this.peers = next
    const signature = next
      .map((p) => `${p.user.id}:${p.user.name}:${p.user.color}:${p.state.followingId ?? ''}`)
      .join('|')
    if (signature !== this.peerSignature) {
      this.peerSignature = signature
      this.callbacks.onPeerList(next)
    }
  }
}
