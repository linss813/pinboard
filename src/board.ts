import * as Y from 'yjs'
import {
  DEFAULT_TEXT_COLOR,
  DEFAULT_TEXT_SIZE,
  NOTE_ALIGNMENTS,
  NOTE_COLORS,
  NOTE_DEFAULT_SIZE,
  NOTE_LIST_STYLES,
  NOTE_TEXT_SIZES,
  PEN_COLORS,
  PEN_STYLES,
  normalizeHexColor,
} from '../shared/constants'
import type {
  Anchor,
  ConnectorItem,
  ImageItem,
  Item,
  NoteAlign,
  NoteLine,
  NoteListStyle,
  NoteItem,
  NoteTextSize,
  Point,
  StrokeItem,
  StrokePoint,
  StrokeStyle,
  TextItem,
} from '../shared/types'
import { uuid } from './util'

export const LOCAL_ORIGIN = 'pinboard-local'

type YItem = Y.Map<any>

const MAX_NOTE_LINES = 200
const MAX_NOTE_CHARS = 6000

export function noteLinesFromText(text: string): NoteLine[] {
  const parts = String(text).slice(0, MAX_NOTE_CHARS).split('\n').slice(0, MAX_NOTE_LINES)
  const lines = parts.length ? parts : ['']
  return lines.map((lineText, index) => ({
    id: `legacy-${index}`,
    text: lineText,
    size: NOTE_DEFAULT_SIZE,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    list: 'none',
    align: 'left',
  }))
}

function normalizeSize(value: unknown): NoteTextSize {
  return NOTE_TEXT_SIZES.includes(value as NoteTextSize) ? (value as NoteTextSize) : NOTE_DEFAULT_SIZE
}

function normalizeList(value: unknown): NoteListStyle {
  return NOTE_LIST_STYLES.includes(value as NoteListStyle) ? (value as NoteListStyle) : 'none'
}

function normalizeAlign(value: unknown): NoteAlign {
  return NOTE_ALIGNMENTS.includes(value as NoteAlign) ? (value as NoteAlign) : 'left'
}

export function normalizeNoteLines(lines: NoteLine[]): NoteLine[] {
  const out: NoteLine[] = []
  const seen = new Set<string>()
  const source = Array.isArray(lines) && lines.length ? lines : noteLinesFromText('')
  let chars = 0
  for (const raw of source.slice(0, MAX_NOTE_LINES)) {
    let id = typeof raw.id === 'string' && raw.id ? raw.id : uuid()
    while (seen.has(id)) id = uuid()
    seen.add(id)
    const remaining = Math.max(0, MAX_NOTE_CHARS - chars)
    const text = String(raw.text ?? '').slice(0, remaining)
    chars += text.length
    out.push({
      id,
      text,
      size: normalizeSize(raw.size),
      bold: Boolean(raw.bold),
      italic: Boolean(raw.italic),
      underline: Boolean(raw.underline),
      strike: Boolean(raw.strike),
      list: normalizeList(raw.list),
      align: normalizeAlign(raw.align),
    })
  }
  return out.length ? out : noteLinesFromText('')
}

function readNoteLinesFromMap(m: Y.Map<any>): NoteLine[] {
  const raw = m.get('lines')
  if (raw instanceof Y.Array) {
    const out: NoteLine[] = []
    for (const [index, value] of raw.toArray().entries()) {
      if (!(value instanceof Y.Map)) continue
      const textValue = value.get('text')
      const text =
        textValue instanceof Y.Text ? textValue.toString() : typeof textValue === 'string' ? textValue : ''
      out.push({
        id: str(value.get('id'), `legacy-${index}`),
        text,
        size: normalizeSize(value.get('size')),
        bold: Boolean(value.get('bold')),
        italic: Boolean(value.get('italic')),
        underline: Boolean(value.get('underline')),
        strike: Boolean(value.get('strike')),
        list: normalizeList(value.get('list')),
        align: normalizeAlign(value.get('align')),
      })
    }
    if (out.length) return out
  }
  const legacy = m.get('text')
  if (legacy instanceof Y.Text) return noteLinesFromText(legacy.toString())
  return noteLinesFromText(typeof legacy === 'string' ? legacy : '')
}

export function applyTextDiff(ytext: Y.Text, next: string): boolean {
  const prev = ytext.toString()
  if (prev === next) return false
  let start = 0
  const min = Math.min(prev.length, next.length)
  while (start < min && prev[start] === next[start]) start++
  let endPrev = prev.length
  let endNext = next.length
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--
    endNext--
  }
  const insert = next.slice(start, endNext)
  const remove = endPrev - start
  const doc = ytext.doc
  const apply = () => {
    if (remove > 0) ytext.delete(start, remove)
    if (insert) ytext.insert(start, insert)
  }
  if (doc) doc.transact(apply, LOCAL_ORIGIN)
  else apply()
  return true
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function normalizeAnchor(value: unknown): Anchor | null {
  if (!value || typeof value !== 'object') return null
  const a = value as Record<string, unknown>
  if (typeof a.noteId === 'string') return { noteId: a.noteId }
  if (typeof a.x === 'number' && typeof a.y === 'number') return { x: a.x, y: a.y }
  return null
}

function pointsOf(value: unknown): StrokePoint[] {
  if (!(value instanceof Y.Array)) return []
  const out: StrokePoint[] = []
  for (const p of value.toArray()) {
    if (p && typeof p === 'object' && typeof (p as Point).x === 'number' && typeof (p as Point).y === 'number') {
      const point: StrokePoint = { x: (p as Point).x, y: (p as Point).y }
      const pressure = (p as StrokePoint).pressure
      if (typeof pressure === 'number' && Number.isFinite(pressure)) {
        point.pressure = Math.max(0, Math.min(1, pressure))
      }
      out.push(point)
    }
  }
  return out
}

function normalizeStrokeStyle(value: unknown): StrokeStyle {
  return PEN_STYLES.includes(value as StrokeStyle) ? (value as StrokeStyle) : 'pen'
}

function normalizeStrokeColor(value: unknown): string {
  return normalizeHexColor(value, PEN_COLORS[0])
}

function normalizeNoteColor(value: unknown): string {
  return normalizeHexColor(value, NOTE_COLORS[0])
}

function normalizeTextColor(value: unknown): string {
  return normalizeHexColor(value, DEFAULT_TEXT_COLOR)
}

function normalizeTextSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(10, Math.min(160, value)) : DEFAULT_TEXT_SIZE
}

function storedStrokePoint(point: StrokePoint): StrokePoint {
  const out: StrokePoint = { x: num(point.x), y: num(point.y) }
  if (typeof point.pressure === 'number' && Number.isFinite(point.pressure)) {
    out.pressure = Math.max(0, Math.min(1, point.pressure))
  }
  return out
}

export interface SeedContent {
  title: string
  welcome: string
  pin: string
  laser: string
}

const DEFAULT_SEED: SeedContent = {
  title: '欢迎来到钉板',
  welcome: '欢迎来到协作白板\n双击编辑，拖动摆放。',
  pin: '把重点钉在板上\n点击内容顶部的图钉固定它。',
  laser: '按住 L 使用激光笔\n点击右上角头像可以跟随队友。',
}

export interface PinResult {
  pinned: boolean
  ids: string[]
}

export interface DeleteResult {
  ok: boolean
  blocked: string[]
  deleted: string[]
}

export class Board {
  readonly doc: Y.Doc
  readonly items: Y.Map<YItem>
  readonly meta: Y.Map<any>
  readonly undoManager: Y.UndoManager

  private cache: Item[] | null = null
  private notesCache: Map<string, NoteItem> | null = null
  private listeners = new Set<() => void>()

  constructor(doc: Y.Doc) {
    this.doc = doc
    this.items = doc.getMap<YItem>('items')
    this.meta = doc.getMap<any>('meta')
    this.undoManager = new Y.UndoManager([this.items, this.meta], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 350,
    })
    doc.on('update', () => {
      this.cache = null
      this.notesCache = null
      for (const listener of this.listeners) listener()
    })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  transaction<T>(fn: () => T, origin: unknown = LOCAL_ORIGIN): T {
    return this.doc.transact(fn, origin)
  }

  stopCapturing(): void {
    this.undoManager.stopCapturing()
  }

  undo(): boolean {
    if (!this.undoManager.canUndo()) return false
    this.undoManager.undo()
    return true
  }

  redo(): boolean {
    if (!this.undoManager.canRedo()) return false
    this.undoManager.redo()
    return true
  }

  allItems(): Item[] {
    if (!this.cache) this.cache = this.buildItems()
    return this.cache
  }

  visibleItems(): Item[] {
    return this.allItems().filter((i) => !i.deleted)
  }

  visibleNotes(): Map<string, NoteItem> {
    if (!this.notesCache) {
      const map = new Map<string, NoteItem>()
      for (const item of this.visibleItems()) if (item.type === 'note') map.set(item.id, item)
      this.notesCache = map
    }
    return this.notesCache
  }

  item(id: string): Item | null {
    return this.allItems().find((i) => i.id === id) ?? null
  }

  title(): string {
    return str(this.meta.get('title'), '')
  }

  setTitle(title: string): void {
    this.doc.transact(() => {
      this.meta.set('title', title.slice(0, 60))
      this.meta.set('titleUpdatedAt', Date.now())
    }, LOCAL_ORIGIN)
  }

  private nextZ(): number {
    let max = 0
    this.items.forEach((m) => {
      if (m instanceof Y.Map) max = Math.max(max, num(m.get('z')))
    })
    return max + 1
  }

  private baseFields(type: Item['type'], z: number): Record<string, unknown> {
    return {
      type,
      z,
      pinned: false,
      pinnedAt: null,
      deleted: false,
      groupId: null,
      createdAt: Date.now(),
    }
  }

  createNote(rect: { x: number; y: number; w: number; h: number }, color: string, text = ''): string {
    const id = uuid()
    const lines = normalizeNoteLines(noteLinesFromText(text).map((line) => ({ ...line, id: uuid() })))
    this.doc.transact(() => {
      const m = new Y.Map()
      for (const [key, value] of Object.entries(this.baseFields('note', this.nextZ()))) m.set(key, value)
      m.set('x', rect.x)
      m.set('y', rect.y)
      m.set('w', rect.w)
      m.set('h', rect.h)
      m.set('color', normalizeNoteColor(color))
      const ylines = new Y.Array<Y.Map<any>>()
      m.set('lines', ylines)
      this.items.set(id, m)
      for (const line of lines) {
        const map = this.createLineMap(line)
        ylines.push([map])
        const ytext = map.get('text')
        if (line.text && ytext instanceof Y.Text) ytext.insert(0, line.text)
      }
    }, LOCAL_ORIGIN)
    return id
  }

  createText(rect: { x: number; y: number; w: number; h: number }, color: string, fontSize: number, text = ''): string {
    const id = uuid()
    this.doc.transact(() => {
      const m = new Y.Map()
      for (const [key, value] of Object.entries(this.baseFields('text', this.nextZ()))) m.set(key, value)
      m.set('x', rect.x)
      m.set('y', rect.y)
      m.set('w', rect.w)
      m.set('h', rect.h)
      m.set('color', normalizeTextColor(color))
      m.set('fontSize', normalizeTextSize(fontSize))
      const ytext = new Y.Text()
      m.set('text', ytext)
      this.items.set(id, m)
      if (text) ytext.insert(0, text.slice(0, MAX_NOTE_CHARS))
    }, LOCAL_ORIGIN)
    return id
  }

  private createLineMap(line: NoteLine): Y.Map<any> {
    const map = new Y.Map()
    map.set('id', line.id)
    map.set('text', new Y.Text())
    map.set('size', line.size)
    map.set('bold', line.bold)
    map.set('italic', line.italic)
    map.set('underline', line.underline)
    map.set('strike', line.strike)
    map.set('list', line.list)
    map.set('align', line.align)
    return map
  }

  private writeLineMap(map: Y.Map<any>, line: NoteLine): void {
    if (map.get('id') !== line.id) map.set('id', line.id)
    let ytext = map.get('text')
    if (!(ytext instanceof Y.Text)) {
      ytext = new Y.Text()
      map.set('text', ytext)
    }
    applyTextDiff(ytext as Y.Text, line.text)
    const attrs: [string, unknown][] = [
      ['size', line.size],
      ['bold', line.bold],
      ['italic', line.italic],
      ['underline', line.underline],
      ['strike', line.strike],
      ['list', line.list],
      ['align', line.align],
    ]
    for (const [key, value] of attrs) {
      if (map.get(key) !== value) map.set(key, value)
    }
  }

  createImage(data: {
    x: number
    y: number
    w: number
    h: number
    assetId: string
    naturalW: number
    naturalH: number
  }): string {
    const id = uuid()
    this.doc.transact(() => {
      const m = new Y.Map()
      for (const [key, value] of Object.entries(this.baseFields('image', this.nextZ()))) m.set(key, value)
      m.set('x', data.x)
      m.set('y', data.y)
      m.set('w', data.w)
      m.set('h', data.h)
      m.set('assetId', data.assetId)
      m.set('naturalW', data.naturalW)
      m.set('naturalH', data.naturalH)
      this.items.set(id, m)
    }, LOCAL_ORIGIN)
    return id
  }

  beginStroke(
    color: string,
    width: number,
    point: StrokePoint,
    style: StrokeStyle = 'pen',
    pressureSensitivity = 0.65,
  ): string {
    const id = uuid()
    this.doc.transact(() => {
      const m = new Y.Map()
      for (const [key, value] of Object.entries(this.baseFields('stroke', this.nextZ()))) m.set(key, value)
      m.set('x', 0)
      m.set('y', 0)
      m.set('color', normalizeStrokeColor(color))
      m.set('width', Math.max(0.5, width))
      m.set('style', normalizeStrokeStyle(style))
      m.set('pressureSensitivity', Math.max(0, Math.min(1, pressureSensitivity)))
      const points = new Y.Array<StrokePoint>()
      m.set('points', points)
      this.items.set(id, m)
      points.push([storedStrokePoint(point)])
    }, LOCAL_ORIGIN)
    return id
  }

  appendStrokePoint(id: string, point: StrokePoint): void {
    this.appendStrokePoints(id, [point])
  }

  appendStrokePoints(id: string, points: StrokePoint[]): void {
    const m = this.items.get(id)
    if (!(m instanceof Y.Map) || !points.length) return
    const stored = m.get('points')
    if (!(stored instanceof Y.Array)) return
    const clean = points.map(storedStrokePoint)
    this.doc.transact(() => stored.push(clean), LOCAL_ORIGIN)
  }

  createConnector(a: Anchor, b: Anchor): string | null {
    if ('noteId' in a && 'noteId' in b && a.noteId === b.noteId) return null
    const id = uuid()
    this.doc.transact(() => {
      const m = new Y.Map()
      for (const [key, value] of Object.entries(this.baseFields('connector', this.nextZ()))) m.set(key, value)
      m.set('a', a)
      m.set('b', b)
      this.items.set(id, m)
    }, LOCAL_ORIGIN)
    return id
  }

  setBoxRect(id: string, rect: Partial<{ x: number; y: number; w: number; h: number }>): boolean {
    const m = this.items.get(id)
    if (!(m instanceof Y.Map)) return false
    if (Boolean(m.get('pinned'))) return false
    const type = m.get('type')
    if (type !== 'note' && type !== 'text' && type !== 'image') return false
    this.doc.transact(() => {
      for (const [key, value] of Object.entries(rect)) {
        if (typeof value === 'number' && Number.isFinite(value)) m.set(key, value)
      }
    }, LOCAL_ORIGIN)
    return true
  }

  groupMembers(groupId: string, items = this.visibleItems()): Item[] {
    return items.filter((item) => item.groupId === groupId && item.type !== 'connector')
  }

  expandGroups(ids: string[]): string[] {
    const items = this.visibleItems()
    const selected = new Set(ids)
    for (const item of items) {
      if (item.groupId && selected.has(item.id)) {
        for (const member of items) if (member.groupId === item.groupId) selected.add(member.id)
      }
    }
    return [...selected]
  }

  groupItems(ids: string[]): string | null {
    const items = this.expandGroups(ids)
      .map((id) => this.item(id))
      .filter((item): item is Item => Boolean(item) && !item!.deleted && item!.type !== 'connector')
    if (items.length < 2) return null
    const groupId = uuid()
    this.doc.transact(() => {
      for (const item of items) {
        const m = this.items.get(item.id)
        if (m instanceof Y.Map) m.set('groupId', groupId)
      }
    }, LOCAL_ORIGIN)
    return groupId
  }

  ungroupItems(ids: string[]): boolean {
    const targetIds = new Set(this.expandGroups(ids))
    const targets = this.visibleItems().filter((item) => targetIds.has(item.id) && item.groupId)
    if (!targets.length) return false
    this.doc.transact(() => {
      for (const item of targets) {
        const m = this.items.get(item.id)
        if (m instanceof Y.Map) m.set('groupId', null)
      }
    }, LOCAL_ORIGIN)
    return true
  }

  moveItems(ids: string[], dx: number, dy: number): string[] {
    if (!dx && !dy) return []
    const blocked: string[] = []
    const current = new Map(this.visibleItems().map((item) => [item.id, item]))
    this.doc.transact(() => {
      for (const id of ids) {
        const item = current.get(id)
        if (!item || item.type === 'connector') continue
        if (item.pinned) {
          blocked.push(id)
          continue
        }
        const m = this.items.get(id)
        if (!(m instanceof Y.Map)) continue
        m.set('x', num(m.get('x')) + dx)
        m.set('y', num(m.get('y')) + dy)
      }
    }, LOCAL_ORIGIN)
    return blocked
  }

  moveItemTo(id: string, x: number, y: number): boolean {
    const item = this.item(id)
    if (!item || item.type === 'connector' || item.pinned) return false
    const m = this.items.get(id)
    if (!(m instanceof Y.Map)) return false
    this.doc.transact(() => {
      m.set('x', x)
      m.set('y', y)
    }, LOCAL_ORIGIN)
    return true
  }

  deleteItems(ids: string[]): DeleteResult {
    const all = this.allItems()
    const byId = new Map(all.map((item) => [item.id, item]))
    const selected = [...new Set(ids)].filter((id) => byId.has(id) && !byId.get(id)!.deleted)
    const blocked = selected.filter((id) => byId.get(id)!.pinned)
    const deletable = selected.filter((id) => !byId.get(id)!.pinned)
    if (!deletable.length) return { ok: false, blocked, deleted: [] }

    const noteIds = new Set(deletable.filter((id) => byId.get(id)!.type === 'note'))
    const cascade = all
      .filter((item) => {
        if (item.deleted) return false
        if (item.type !== 'connector') return false
        if (deletable.includes(item.id)) return true
        const anchorHits = (anchor: Anchor | undefined) => {
          if (anchor && 'noteId' in anchor) return noteIds.has(anchor.noteId)
          return false
        }
        return anchorHits((item as ConnectorItem).a) || anchorHits((item as ConnectorItem).b)
      })
      .map((item) => item.id)

    const toDelete = [...new Set([...deletable, ...cascade])]
    const deletedSet = new Set(toDelete)
    const touchedGroups = new Set(
      deletable
        .map((id) => byId.get(id)!.groupId)
        .filter((groupId): groupId is string => Boolean(groupId)),
    )
    this.doc.transact(() => {
      for (const id of toDelete) {
        const m = this.items.get(id)
        if (m instanceof Y.Map) m.set('deleted', true)
      }
      for (const groupId of touchedGroups) {
        const remaining = all.filter(
          (item) => item.groupId === groupId && !item.deleted && !deletedSet.has(item.id) && item.type !== 'connector',
        )
        if (remaining.length >= 2) continue
        for (const item of remaining) {
          const m = this.items.get(item.id)
          if (m instanceof Y.Map) m.set('groupId', null)
        }
      }
    }, LOCAL_ORIGIN)
    return { ok: true, blocked, deleted: toDelete }
  }

  togglePin(ids: string[]): PinResult | null {
    const targets = this.visibleItems().filter((item) => ids.includes(item.id) && item.type !== 'connector')
    if (!targets.length) return null
    const nextPinned = !targets.every((item) => item.pinned)
    const now = Date.now()
    this.doc.transact(() => {
      for (const item of targets) {
        const m = this.items.get(item.id)
        if (!(m instanceof Y.Map)) continue
        m.set('pinned', nextPinned)
        m.set('pinnedAt', nextPinned ? now : null)
      }
    }, LOCAL_ORIGIN)
    return { pinned: nextPinned, ids: targets.map((t) => t.id) }
  }

  setNoteColor(id: string, color: string): void {
    const m = this.items.get(id)
    if (!(m instanceof Y.Map) || m.get('type') !== 'note') return
    this.doc.transact(() => m.set('color', normalizeNoteColor(color)), LOCAL_ORIGIN)
  }

  setTextColor(id: string, color: string): void {
    const m = this.items.get(id)
    if (!(m instanceof Y.Map) || m.get('type') !== 'text') return
    this.doc.transact(() => m.set('color', normalizeTextColor(color)), LOCAL_ORIGIN)
  }

  setTextSize(id: string, fontSize: number): void {
    const m = this.items.get(id)
    if (!(m instanceof Y.Map) || m.get('type') !== 'text') return
    this.doc.transact(() => m.set('fontSize', normalizeTextSize(fontSize)), LOCAL_ORIGIN)
  }

  getYText(id: string): Y.Text | null {
    const m = this.items.get(id)
    if (!(m instanceof Y.Map) || (m.get('type') !== 'note' && m.get('type') !== 'text')) return null
    const text = m.get('text')
    return text instanceof Y.Text ? text : null
  }

  setTextContent(id: string, next: string): boolean {
    const text = this.getYText(id)
    if (!text) return false
    const limited = String(next).slice(0, MAX_NOTE_CHARS)
    return applyTextDiff(text, limited)
  }

  getYLines(id: string): Y.Array<Y.Map<any>> | null {
    const m = this.items.get(id)
    if (!(m instanceof Y.Map) || m.get('type') !== 'note') return null
    const lines = m.get('lines')
    return lines instanceof Y.Array ? lines : null
  }

  ensureNoteLines(id: string): NoteLine[] {
    const m = this.items.get(id)
    if (!(m instanceof Y.Map) || m.get('type') !== 'note') return []
    let lines = m.get('lines')
    if (!(lines instanceof Y.Array)) {
      const legacy = readNoteLinesFromMap(m).map((line, index) => ({
        ...line,
        id: line.id || `legacy-${index}`,
      }))
      const normalized = normalizeNoteLines(legacy)
      this.doc.transact(() => {
        const ylines = new Y.Array<Y.Map<any>>()
        m.set('lines', ylines)
        if (m.get('text') instanceof Y.Text || typeof m.get('text') === 'string') m.delete('text')
        for (const line of normalized) {
          const map = this.createLineMap(line)
          ylines.push([map])
          const ytext = map.get('text')
          if (line.text && ytext instanceof Y.Text) ytext.insert(0, line.text)
        }
      }, LOCAL_ORIGIN)
      lines = m.get('lines')
    }
    return this.noteLines(id)
  }

  noteLines(id: string): NoteLine[] {
    const m = this.items.get(id)
    if (!(m instanceof Y.Map) || m.get('type') !== 'note') return []
    return readNoteLinesFromMap(m)
  }

  setNoteLines(id: string, lines: NoteLine[]): boolean {
    const m = this.items.get(id)
    if (!(m instanceof Y.Map) || m.get('type') !== 'note') return false
    const next = normalizeNoteLines(lines)
    this.ensureNoteLines(id)
    const ylines = this.getYLines(id)
    if (!ylines) return false
    const desiredIds = new Set(next.map((line) => line.id))
    this.doc.transact(() => {
      for (let index = ylines.length - 1; index >= 0; index--) {
        const map = ylines.get(index)
        if (!(map instanceof Y.Map) || !desiredIds.has(str(map.get('id')))) ylines.delete(index, 1)
      }
      for (let index = 0; index < next.length; index++) {
        const line = next[index]
        let map = index < ylines.length ? ylines.get(index) : null
        if (map instanceof Y.Map && map.get('id') !== line.id) {
          const existsLater = ylines.toArray().some((item, at) => at > index && item instanceof Y.Map && item.get('id') === line.id)
          if (existsLater) {
            ylines.delete(index, 1)
            map = null
          }
        }
        if (!(map instanceof Y.Map) || map.get('id') !== line.id) {
          map = this.createLineMap({ ...line, text: '' })
          ylines.insert(index, [map])
        }
        this.writeLineMap(map, line)
      }
      if (ylines.length > next.length) ylines.delete(next.length, ylines.length - next.length)
    }, LOCAL_ORIGIN)
    return true
  }

  setLineAttrs(
    id: string,
    lineIds: string[],
    patch: Partial<Pick<NoteLine, 'size' | 'bold' | 'italic' | 'underline' | 'strike' | 'list' | 'align'>>,
  ): boolean {
    const m = this.items.get(id)
    if (!(m instanceof Y.Map) || m.get('type') !== 'note') return false
    const ylines = this.getYLines(id)
    if (!ylines) return false
    const ids = new Set(lineIds)
    const maps = ylines
      .toArray()
      .filter((line): line is Y.Map<any> => line instanceof Y.Map && ids.has(str(line.get('id'))))
    if (!maps.length) return false
    const safe: Record<string, unknown> = {}
    if (patch.size !== undefined) safe.size = normalizeSize(patch.size)
    if (patch.list !== undefined) safe.list = normalizeList(patch.list)
    if (patch.align !== undefined) safe.align = normalizeAlign(patch.align)
    for (const key of ['bold', 'italic', 'underline', 'strike'] as const) {
      if (patch[key] !== undefined) safe[key] = Boolean(patch[key])
    }
    this.doc.transact(() => {
      for (const map of maps) {
        for (const [key, value] of Object.entries(safe)) {
          if (map.get(key) !== value) map.set(key, value)
        }
      }
    }, LOCAL_ORIGIN)
    return true
  }

  setNoteText(id: string, next: string): boolean {
    if (!this.item(id)) return false
    const existing = this.noteLines(id)
    const parts = String(next).slice(0, MAX_NOTE_CHARS).split('\n').slice(0, MAX_NOTE_LINES)
    const nextLines = (parts.length ? parts : ['']).map((text, index) => {
      const style = existing[index] ?? existing[existing.length - 1]
      return {
        ...(style ?? noteLinesFromText('')[0]),
        id: existing[index]?.id ?? uuid(),
        text,
      }
    })
    return this.setNoteLines(id, nextLines)
  }

  duplicateItems(ids: string[]): string[] {
    const current = this.visibleItems().filter((item) => ids.includes(item.id) && item.type !== 'connector')
    if (!current.length) return []
    const newIds: string[] = []
    const groupMap = new Map<string, string>()
    this.doc.transact(() => {
      for (const item of current) {
        const id = uuid()
        const m = new Y.Map()
        const base = this.baseFields(item.type, this.nextZ())
        for (const [key, value] of Object.entries(base)) m.set(key, value)
        if (item.groupId) {
          if (!groupMap.has(item.groupId)) groupMap.set(item.groupId, uuid())
          m.set('groupId', groupMap.get(item.groupId))
        }
        if (item.type === 'note') {
          m.set('x', item.x + 26)
          m.set('y', item.y + 26)
          m.set('w', item.w)
          m.set('h', item.h)
          m.set('color', normalizeNoteColor(item.color))
          const ylines = new Y.Array<Y.Map<any>>()
          m.set('lines', ylines)
          this.items.set(id, m)
          const lines = normalizeNoteLines(
            (item.lines ?? noteLinesFromText(item.text)).map((line) => ({ ...line, id: uuid() })),
          )
          for (const line of lines) {
            const lineMap = this.createLineMap(line)
            ylines.push([lineMap])
            const ytext = lineMap.get('text')
            if (line.text && ytext instanceof Y.Text) ytext.insert(0, line.text)
          }
        } else if (item.type === 'text') {
          m.set('x', item.x + 26)
          m.set('y', item.y + 26)
          m.set('w', item.w)
          m.set('h', item.h)
          m.set('color', normalizeTextColor(item.color))
          m.set('fontSize', normalizeTextSize(item.fontSize))
          const ytext = new Y.Text()
          m.set('text', ytext)
          this.items.set(id, m)
          if (item.text) ytext.insert(0, item.text)
        } else if (item.type === 'image') {
          m.set('x', item.x + 26)
          m.set('y', item.y + 26)
          m.set('w', item.w)
          m.set('h', item.h)
          m.set('assetId', item.assetId)
          m.set('naturalW', item.naturalW)
          m.set('naturalH', item.naturalH)
          this.items.set(id, m)
        } else if (item.type === 'stroke') {
          m.set('x', item.x + 26)
          m.set('y', item.y + 26)
          m.set('color', normalizeStrokeColor(item.color))
          m.set('width', item.width)
          m.set('style', normalizeStrokeStyle(item.style))
          m.set('pressureSensitivity', item.pressureSensitivity ?? 0.65)
          const points = new Y.Array<StrokePoint>()
          m.set('points', points)
          this.items.set(id, m)
          if (item.points.length) points.push(item.points.map((p) => storedStrokePoint(p)))
        }
        newIds.push(id)
      }
    }, LOCAL_ORIGIN)
    return newIds
  }

  bringToFront(ids: string[]): void {
    if (!ids.length) return
    this.doc.transact(() => {
      let z = this.nextZ()
      for (const id of ids) {
        const m = this.items.get(id)
        if (m instanceof Y.Map) m.set('z', z++)
      }
    }, LOCAL_ORIGIN)
  }

  sendToBack(ids: string[]): void {
    if (!ids.length) return
    let min = 0
    this.items.forEach((m) => {
      if (m instanceof Y.Map) min = Math.min(min, num(m.get('z')))
    })
    this.doc.transact(() => {
      let z = min - ids.length
      for (const id of ids) {
        const m = this.items.get(id)
        if (m instanceof Y.Map) m.set('z', z++)
      }
    }, LOCAL_ORIGIN)
  }

  seedIfEmpty(content: SeedContent = DEFAULT_SEED): boolean {
    if (this.meta.get('seeded')) return false
    if (this.items.size > 0) {
      this.doc.transact(() => this.meta.set('seeded', true), 'seed')
      return false
    }
    const now = Date.now()
    const seedNote = (id: string, x: number, y: number, w: number, h: number, color: string, text: string, pinned = false, z = 1) => {
      const m = new Y.Map()
      m.set('type', 'note')
      m.set('z', z)
      m.set('pinned', pinned)
      m.set('pinnedAt', pinned ? now : null)
      m.set('deleted', false)
      m.set('groupId', null)
      m.set('createdAt', now)
      m.set('x', x)
      m.set('y', y)
      m.set('w', w)
      m.set('h', h)
      m.set('color', color)
      const ylines = new Y.Array<Y.Map<any>>()
      m.set('lines', ylines)
      this.items.set(id, m)
      for (const line of normalizeNoteLines(noteLinesFromText(text).map((item) => ({ ...item, id: uuid() })))) {
        const lineMap = this.createLineMap(line)
        ylines.push([lineMap])
        const ytext = lineMap.get('text')
        if (line.text && ytext instanceof Y.Text) ytext.insert(0, line.text)
      }
    }
    this.doc.transact(() => {
      this.meta.set('seeded', true)
      if (!this.meta.get('title')) this.meta.set('title', content.title)
      seedNote('seed-welcome', 120, 120, 200, 160, NOTE_COLORS[0], content.welcome)
      seedNote('seed-pin', 390, 200, 200, 160, NOTE_COLORS[2], content.pin, true, 2)
      seedNote('seed-laser', 240, 390, 210, 150, NOTE_COLORS[3], content.laser, false, 3)
      const c = new Y.Map()
      c.set('type', 'connector')
      c.set('z', 4)
      c.set('pinned', false)
      c.set('pinnedAt', null)
      c.set('deleted', false)
      c.set('groupId', null)
      c.set('createdAt', now)
      c.set('a', { noteId: 'seed-welcome' })
      c.set('b', { noteId: 'seed-pin' })
      this.items.set('seed-connector', c)
    }, 'seed')
    return true
  }

  importItems(items: Item[], origin: unknown = LOCAL_ORIGIN): { ids: string[]; idMap: Map<string, string> } {
    const idMap = new Map<string, string>()
    const groupMap = new Map<string, string>()
    const ids: string[] = []
    this.doc.transact(() => {
      for (const item of items) {
        const id = this.items.has(item.id) ? uuid() : item.id
        idMap.set(item.id, id)
      }
      let z = this.nextZ()
      for (const item of items) {
        const id = idMap.get(item.id)!
        const m = new Y.Map()
        m.set('type', item.type)
        m.set('z', z++)
        m.set('pinned', Boolean(item.pinned))
        m.set('pinnedAt', item.pinnedAt ?? null)
        m.set('deleted', false)
        m.set('groupId', null)
        m.set('createdAt', Date.now())
        if (item.groupId && item.type !== 'connector') {
          if (!groupMap.has(item.groupId)) groupMap.set(item.groupId, uuid())
          m.set('groupId', groupMap.get(item.groupId))
        }
        if (item.type === 'note') {
          m.set('x', item.x)
          m.set('y', item.y)
          m.set('w', item.w)
          m.set('h', item.h)
          m.set('color', normalizeNoteColor(item.color))
          const ylines = new Y.Array<Y.Map<any>>()
          m.set('lines', ylines)
          this.items.set(id, m)
          const lines = normalizeNoteLines(
            (item.lines ?? noteLinesFromText(item.text)).map((line) => ({ ...line, id: uuid() })),
          )
          for (const line of lines) {
            const lineMap = this.createLineMap(line)
            ylines.push([lineMap])
            const ytext = lineMap.get('text')
            if (line.text && ytext instanceof Y.Text) ytext.insert(0, line.text)
          }
        } else if (item.type === 'text') {
          m.set('x', item.x)
          m.set('y', item.y)
          m.set('w', item.w)
          m.set('h', item.h)
          m.set('color', normalizeTextColor(item.color))
          m.set('fontSize', normalizeTextSize(item.fontSize))
          const ytext = new Y.Text()
          m.set('text', ytext)
          this.items.set(id, m)
          if (item.text) ytext.insert(0, item.text)
        } else if (item.type === 'image') {
          m.set('x', item.x)
          m.set('y', item.y)
          m.set('w', item.w)
          m.set('h', item.h)
          m.set('assetId', item.assetId)
          m.set('naturalW', item.naturalW)
          m.set('naturalH', item.naturalH)
          this.items.set(id, m)
        } else if (item.type === 'stroke') {
          m.set('x', item.x)
          m.set('y', item.y)
          m.set('color', normalizeStrokeColor(item.color))
          m.set('width', item.width)
          m.set('style', normalizeStrokeStyle(item.style))
          m.set('pressureSensitivity', item.pressureSensitivity ?? 0.65)
          const points = new Y.Array<StrokePoint>()
          m.set('points', points)
          this.items.set(id, m)
          if (item.points.length) points.push(item.points.map((p) => storedStrokePoint(p)))
        } else {
          const remap = (anchor: Anchor): Anchor => {
            if ('noteId' in anchor) {
              const mapped = idMap.get(anchor.noteId)
              return mapped ? { noteId: mapped } : anchor
            }
            return anchor
          }
          m.set('a', remap(item.a))
          m.set('b', remap(item.b))
          this.items.set(id, m)
        }
        ids.push(id)
      }
    }, origin)
    return { ids, idMap }
  }

  private buildItems(): Item[] {
    const out: Item[] = []
    this.items.forEach((m, id) => {
      if (!(m instanceof Y.Map)) return
      const type = m.get('type')
      const pinned = Boolean(m.get('pinned'))
      const pinnedAtRaw = m.get('pinnedAt')
      const base = {
        id,
        z: num(m.get('z')),
        pinned,
        pinnedAt: typeof pinnedAtRaw === 'number' ? pinnedAtRaw : null,
        deleted: Boolean(m.get('deleted')),
        groupId: typeof m.get('groupId') === 'string' ? (m.get('groupId') as string) : null,
      }
      if (type === 'note') {
        const lines = readNoteLinesFromMap(m)
        out.push({
          ...base,
          type: 'note',
          x: num(m.get('x')),
          y: num(m.get('y')),
          w: Math.max(50, num(m.get('w'), 180)),
          h: Math.max(50, num(m.get('h'), 180)),
          color: normalizeNoteColor(m.get('color')),
          text: lines.map((line) => line.text).join('\n'),
          lines,
        })
      } else if (type === 'text') {
        const raw = m.get('text')
        out.push({
          ...base,
          type: 'text',
          x: num(m.get('x')),
          y: num(m.get('y')),
          w: Math.max(40, num(m.get('w'), 240)),
          h: Math.max(28, num(m.get('h'), 72)),
          color: normalizeTextColor(m.get('color')),
          fontSize: normalizeTextSize(m.get('fontSize')),
          text: raw instanceof Y.Text ? raw.toString().slice(0, MAX_NOTE_CHARS) : str(raw),
        })
      } else if (type === 'image') {
        out.push({
          ...base,
          type: 'image',
          x: num(m.get('x')),
          y: num(m.get('y')),
          w: Math.max(20, num(m.get('w'), 240)),
          h: Math.max(20, num(m.get('h'), 180)),
          assetId: str(m.get('assetId')),
          naturalW: Math.max(1, num(m.get('naturalW'), 1)),
          naturalH: Math.max(1, num(m.get('naturalH'), 1)),
        })
      } else if (type === 'stroke') {
        out.push({
          ...base,
          type: 'stroke',
          x: num(m.get('x')),
          y: num(m.get('y')),
          points: pointsOf(m.get('points')),
          color: normalizeStrokeColor(m.get('color')),
          width: Math.max(0.5, num(m.get('width'), 4)),
          style: normalizeStrokeStyle(m.get('style')),
          pressureSensitivity: clamp01(num(m.get('pressureSensitivity'), 0.65)),
        })
      } else if (type === 'connector') {
        const a = normalizeAnchor(m.get('a'))
        const b = normalizeAnchor(m.get('b'))
        if (a && b) {
          out.push({ ...base, type: 'connector', a, b })
        }
      }
    })
    out.sort((a, b) => a.z - b.z || a.id.localeCompare(b.id))
    return out
  }
}
