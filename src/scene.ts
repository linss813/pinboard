import type { Item, NoteItem, PeerUser, Point, Rect } from '../shared/types'
import type { Camera } from '../shared/geometry'

export type Tool = 'select' | 'lasso' | 'note' | 'text' | 'pen' | 'eraser' | 'connect' | 'laser'

export interface BrushPreview {
  x: number
  y: number
  radius: number
  color: string
  opacity: number
  eraser: boolean
}

export interface PendingConnect {
  a: Point
  b: Point
  targetId: string | null
  valid: boolean
}

export interface PeerCursor {
  clientId: number
  user: PeerUser
  cursor: Point | null
  selection: string[]
  editingId: string | null
  view?: { cx: number; cy: number; scale: number }
  followId: string | null
}

export interface LaserTrail {
  clientId: number | 'local'
  color: string
  points: { x: number; y: number; t: number }[]
}

export interface FloatingReaction {
  id: string
  kind: string
  x: number
  y: number
  start: number
  updatedAt: number
  count: number
  color?: string
}

export interface FlashState {
  id: string
  start: number
  until: number
}

export interface Scene {
  camera: Camera
  items: Item[]
  notes: Map<string, NoteItem>
  selection: Set<string>
  hoveredId: string | null
  hoveredPinId: string | null
  editingId: string | null
  marquee: Rect | null
  lasso: Point[] | null
  brushPreview: BrushPreview | null
  pendingConnect: PendingConnect | null
  peers: PeerCursor[]
  lasers: LaserTrail[]
  reactions: FloatingReaction[]
  flash: FlashState | null
  followId: string | null
  selectionDrag: boolean
  now: number
}
