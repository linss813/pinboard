import type { Anchor, ConnectorItem, Item, NoteItem, Point, Rect, StrokeItem } from './types'
import { isConnector, isNote, isStroke } from './types'

export interface Camera {
  x: number
  y: number
  scale: number
}

export const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))

export const worldToScreen = (cam: Camera, p: Point): Point => ({
  x: (p.x - cam.x) * cam.scale,
  y: (p.y - cam.y) * cam.scale,
})

export const screenToWorld = (cam: Camera, sx: number, sy: number): Point => ({
  x: sx / cam.scale + cam.x,
  y: sy / cam.scale + cam.y,
})

export function zoomCameraAt(cam: Camera, sx: number, sy: number, factor: number): Camera {
  const nextScale = clamp(cam.scale * factor, 0.1, 4)
  if (nextScale === cam.scale) return cam
  const w = screenToWorld(cam, sx, sy)
  return {
    scale: nextScale,
    x: w.x - sx / nextScale,
    y: w.y - sy / nextScale,
  }
}

export function fitCameraToBounds(
  bounds: Rect,
  viewportW: number,
  viewportH: number,
  padding = 0.92,
  maxScale = 2,
): Camera {
  const scale = clamp(Math.min(viewportW / Math.max(1, bounds.w), viewportH / Math.max(1, bounds.h)) * padding, 0.1, maxScale)
  return {
    scale,
    x: bounds.x + bounds.w / 2 - viewportW / scale / 2,
    y: bounds.y + bounds.h / 2 - viewportH / scale / 2,
  }
}

export function pointInRect(p: Point, r: Rect, tolerance = 0): boolean {
  return (
    p.x >= r.x - tolerance &&
    p.x <= r.x + r.w + tolerance &&
    p.y >= r.y - tolerance &&
    p.y <= r.y + r.h + tolerance
  )
}

function pointOnSegment(p: Point, a: Point, b: Point, epsilon = 0.001): boolean {
  const lenSq = (b.x - a.x) ** 2 + (b.y - a.y) ** 2
  if (lenSq <= epsilon * epsilon) {
    return Math.abs(p.x - a.x) <= epsilon && Math.abs(p.y - a.y) <= epsilon
  }
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
  if (Math.abs(cross) > epsilon) return false
  const dot = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)
  if (dot < 0) return false
  return dot <= lenSq
}

export function pointInPolygon(p: Point, polygon: Point[]): boolean {
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (pointOnSegment(p, a, b)) return true
    const intersects = a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    if (intersects) inside = !inside
  }
  return inside
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  }
}

export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0
  t = clamp(t, 0, 1)
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

export function noteCenter(note: Pick<NoteItem, 'x' | 'y' | 'w' | 'h'>): Point {
  return { x: note.x + note.w / 2, y: note.y + note.h / 2 }
}

function anchorPoint(anchor: Anchor, notes: Map<string, NoteItem>): Point | null {
  if ('noteId' in anchor) {
    const n = notes.get(anchor.noteId)
    return n ? noteCenter(n) : null
  }
  return anchor
}

export function edgePointToward(rect: Rect, target: Point): Point {
  const c = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
  const dx = target.x - c.x
  const dy = target.y - c.y
  if (Math.abs(dx) < 0.0001 && Math.abs(dy) < 0.0001) return c
  const tx = Math.abs(dx) < 0.0001 ? Infinity : (rect.w / 2) / Math.abs(dx)
  const ty = Math.abs(dy) < 0.0001 ? Infinity : (rect.h / 2) / Math.abs(dy)
  const t = Math.min(tx, ty)
  if (t >= 1) return target
  return { x: c.x + dx * t, y: c.y + dy * t }
}

export function connectorEndpoints(
  connector: ConnectorItem,
  notes: Map<string, NoteItem>,
): [Point, Point] | null {
  const ca = anchorPoint(connector.a, notes)
  const cb = anchorPoint(connector.b, notes)
  if (!ca || !cb) return null
  let a = ca
  let b = cb
  if ('noteId' in connector.a) {
    const n = notes.get(connector.a.noteId)
    if (n) a = edgePointToward(n, cb)
  }
  if ('noteId' in connector.b) {
    const n = notes.get(connector.b.noteId)
    if (n) b = edgePointToward(n, ca)
  }
  return [a, b]
}

export function strokeBounds(item: StrokeItem): Rect {
  if (item.points.length === 0) return { x: item.x, y: item.y, w: 1, h: 1 }
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of item.points) {
    const x = p.x + item.x
    const y = p.y + item.y
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  const pad = item.width / 2
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 }
}

export function itemBounds(item: Item, notes: Map<string, NoteItem>): Rect {
  if (item.type === 'connector') {
    const ends = connectorEndpoints(item, notes)
    if (!ends) return { x: 0, y: 0, w: 0, h: 0 }
    return rectFromPoints(ends[0], ends[1])
  }
  if (item.type === 'stroke') return strokeBounds(item)
  return { x: item.x, y: item.y, w: item.w, h: item.h }
}

export function pinAnchor(item: Item, notes: Map<string, NoteItem>): Point | null {
  if (item.type === 'note' || item.type === 'text' || item.type === 'image') return { x: item.x + item.w / 2, y: item.y }
  if (item.type === 'stroke') {
    const b = strokeBounds(item)
    return { x: b.x + b.w / 2, y: b.y }
  }
  return null
}

export function hitItem(
  item: Item,
  p: Point,
  notes: Map<string, NoteItem>,
  tolerance = 0,
): boolean {
  if (item.type === 'note' || item.type === 'text' || item.type === 'image') {
    return pointInRect(p, { x: item.x, y: item.y, w: item.w, h: item.h }, tolerance)
  }
  if (item.type === 'stroke') {
    const tol = Math.max(item.width / 2 + tolerance, tolerance + 4)
    for (let i = 0; i < item.points.length - 1; i++) {
      const a = { x: item.points[i].x + item.x, y: item.points[i].y + item.y }
      const b = { x: item.points[i + 1].x + item.x, y: item.points[i + 1].y + item.y }
      if (distanceToSegment(p, a, b) <= tol) return true
    }
    return false
  }
  const ends = connectorEndpoints(item, notes)
  if (!ends) return false
  return distanceToSegment(p, ends[0], ends[1]) <= tolerance + 6
}

export function topItemAt(
  items: Item[],
  p: Point,
  notes: Map<string, NoteItem>,
  tolerance = 0,
): Item | null {
  const sorted = [...items].sort((a, b) => b.z - a.z || b.id.localeCompare(a.id))
  for (const item of sorted) {
    if (hitItem(item, p, notes, tolerance)) return item
  }
  return null
}

export function contentBounds(items: Item[], notes: Map<string, NoteItem>): Rect | null {
  if (!items.length) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const item of items) {
    if (item.type === 'connector' && !connectorEndpoints(item, notes)) continue
    const b = itemBounds(item, notes)
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  if (!Number.isFinite(x0)) return null
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
}

export function selectionBounds(items: Item[], notes: Map<string, NoteItem>): Rect | null {
  return contentBounds(items, notes)
}

export const HANDLE_NAMES = ['nw', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
export type HandleName = (typeof HANDLE_NAMES)[number]

export function handlePoints(rect: Rect): Record<HandleName, Point> {
  return {
    nw: { x: rect.x, y: rect.y },
    ne: { x: rect.x + rect.w, y: rect.y },
    e: { x: rect.x + rect.w, y: rect.y + rect.h / 2 },
    se: { x: rect.x + rect.w, y: rect.y + rect.h },
    s: { x: rect.x + rect.w / 2, y: rect.y + rect.h },
    sw: { x: rect.x, y: rect.y + rect.h },
    w: { x: rect.x, y: rect.y + rect.h / 2 },
  }
}

export function isEditableBox(item: Item): boolean {
  return item.type === 'note' || item.type === 'text' || item.type === 'image'
}

export function isNoteLike(item: Item): item is NoteItem {
  return isNote(item)
}

export function isStrokeLike(item: Item): item is StrokeItem {
  return isStroke(item)
}

export function isConnectorLike(item: Item): item is ConnectorItem {
  return isConnector(item)
}
