import type { Board } from './board'
import type { AssetStore } from './assets'
import { AssetError } from './assets'
import { renderBoardToPng } from './renderer'
import type {
  Anchor,
  ExportFile,
  ImageItem,
  Item,
  NoteItem,
  NoteLine,
  StrokeItem,
  StrokePoint,
  StrokeStyle,
  TextItem,
} from '../shared/types'
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
import { t } from './i18n'
import { dataUrlToBlob, downloadBlob, uuid } from './util'

function safeFilename(title: string): string {
  return (title || 'pinboard').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40) || 'pinboard'
}

export async function exportPng(board: Board, assets: AssetStore): Promise<boolean> {
  const items = board.visibleItems()
  const notes = board.visibleNotes()
  const blob = await renderBoardToPng(items, notes, assets)
  if (!blob) return false
  downloadBlob(blob, `${safeFilename(board.title())}.png`)
  return true
}

export async function exportJson(board: Board, assets: AssetStore): Promise<void> {
  const items = board.visibleItems()
  const imageIds = [...new Set(items.filter((i): i is ImageItem => i.type === 'image').map((i) => i.assetId))]
  const assetPayloads = []
  for (const id of imageIds) {
    const dataUrl = await assets.dataUrl(id)
    if (!dataUrl) continue
    const blob = await assets.getBlob(id)
    assetPayloads.push({ id, mime: blob?.type || 'image/webp', dataUrl })
  }
  const payload: ExportFile = {
    format: 'pinboard',
    version: 1,
    title: board.title(),
    exportedAt: new Date().toISOString(),
    items,
    assets: assetPayloads,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  downloadBlob(blob, `${safeFilename(board.title())}.json`)
}

function finite(n: unknown, fallback: number, min = -1e9, max = 1e9): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

function normalizeGroupId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 80 ? value : null
}

function normalizeLineText(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 4000) : ''
}

function normalizeLines(raw: unknown, fallbackText: string): NoteLine[] {
  const source = Array.isArray(raw) ? raw : null
  const lines: NoteLine[] = []
  const seen = new Set<string>()
  let chars = 0
  if (source) {
    for (const [index, value] of source.slice(0, 200).entries()) {
      if (!value || typeof value !== 'object') continue
      const record = value as Record<string, unknown>
      const remaining = Math.max(0, 6000 - chars)
      const text = normalizeLineText(record.text).slice(0, remaining)
      chars += text.length
      let id = typeof record.id === 'string' && record.id ? record.id.slice(0, 80) : uuid()
      while (seen.has(id)) id = uuid()
      seen.add(id)
      lines.push({
        id,
        text,
        size: NOTE_TEXT_SIZES.includes(record.size as never) ? (record.size as NoteLine['size']) : NOTE_DEFAULT_SIZE,
        bold: Boolean(record.bold),
        italic: Boolean(record.italic),
        underline: Boolean(record.underline),
        strike: Boolean(record.strike),
        list: NOTE_LIST_STYLES.includes(record.list as never) ? (record.list as NoteLine['list']) : 'none',
        align: NOTE_ALIGNMENTS.includes(record.align as never) ? (record.align as NoteLine['align']) : 'left',
      })
    }
  }
  if (lines.length) return lines
  return (fallbackText.slice(0, 6000) || '').split('\n').slice(0, 200).map((text, index) => ({
    id: `import-${index}-${uuid()}`,
    text,
    size: NOTE_DEFAULT_SIZE,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    list: 'none',
    align: 'left',
  }))
}

function normalizeNote(raw: Record<string, unknown>, id: string): NoteItem {
  const text = typeof raw.text === 'string' ? raw.text.slice(0, 6000) : ''
  const lines = normalizeLines(raw.lines, text)
  return {
    id,
    type: 'note',
    z: 0,
    pinned: Boolean(raw.pinned),
    pinnedAt: typeof raw.pinnedAt === 'number' ? raw.pinnedAt : null,
    deleted: false,
    groupId: normalizeGroupId(raw.groupId),
    x: finite(raw.x, 0),
    y: finite(raw.y, 0),
    w: finite(raw.w, 180, 60, 4000),
    h: finite(raw.h, 160, 60, 4000),
    color: normalizeHexColor(raw.color, NOTE_COLORS[0]),
    text: lines.map((line) => line.text).join('\n'),
    lines,
  }
}

function normalizeTextItem(raw: Record<string, unknown>, id: string): TextItem {
  return {
    id,
    type: 'text',
    z: 0,
    pinned: Boolean(raw.pinned),
    pinnedAt: typeof raw.pinnedAt === 'number' ? raw.pinnedAt : null,
    deleted: false,
    groupId: normalizeGroupId(raw.groupId),
    x: finite(raw.x, 0),
    y: finite(raw.y, 0),
    w: finite(raw.w, 240, 40, 4000),
    h: finite(raw.h, 72, 28, 4000),
    text: typeof raw.text === 'string' ? raw.text.slice(0, 6000) : '',
    color: normalizeHexColor(raw.color, DEFAULT_TEXT_COLOR),
    fontSize: finite(raw.fontSize, DEFAULT_TEXT_SIZE, 10, 160),
  }
}

function normalizeStroke(raw: Record<string, unknown>, id: string): StrokeItem | null {
  const rawPoints = Array.isArray(raw.points) ? raw.points : []
  const points: StrokePoint[] = []
  for (const p of rawPoints.slice(0, 6000)) {
    if (p && typeof p === 'object') {
      const point = p as Record<string, unknown>
      const x = finite(point.x, NaN)
      const y = finite(point.y, NaN)
      if (Number.isFinite(x) && Number.isFinite(y)) {
        const stored: StrokePoint = { x, y }
        if (typeof point.pressure === 'number' && Number.isFinite(point.pressure)) {
          stored.pressure = Math.max(0, Math.min(1, point.pressure))
        }
        points.push(stored)
      }
    }
  }
  if (!points.length) return null
  return {
    id,
    type: 'stroke',
    z: 0,
    pinned: Boolean(raw.pinned),
    pinnedAt: typeof raw.pinnedAt === 'number' ? raw.pinnedAt : null,
    deleted: false,
    groupId: normalizeGroupId(raw.groupId),
    x: finite(raw.x, 0),
    y: finite(raw.y, 0),
    points,
    color: normalizeHexColor(raw.color, PEN_COLORS[0]),
    width: finite(raw.width, 4, 0.5, 120),
    style: PEN_STYLES.includes(raw.style as StrokeStyle) ? (raw.style as StrokeStyle) : 'pen',
    pressureSensitivity: finite(raw.pressureSensitivity, 0.65, 0, 1),
  }
}

function normalizeAnchor(value: unknown): Anchor | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.noteId === 'string') return { noteId: raw.noteId }
  if (typeof raw.x === 'number' && typeof raw.y === 'number') {
    return { x: finite(raw.x, 0), y: finite(raw.y, 0) }
  }
  return null
}

export async function importJson(
  file: File,
  board: Board,
  assets: AssetStore,
): Promise<{ count: number; skipped: number }> {
  if (file.size > 120 * 1024 * 1024) throw new Error(t('error.importTooLarge'))
  const text = await file.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(t('error.importInvalidJson'))
  }
  if (!data || typeof data !== 'object') throw new Error(t('error.importInvalidData'))
  const payload = data as Partial<ExportFile>
  if (payload.format !== 'pinboard' || !Array.isArray(payload.items)) {
    throw new Error(t('error.importWrongFormat'))
  }
  const maxItems = 1500
  const rawItems = payload.items.slice(0, maxItems)
  const assetMap = new Map<string, string>()
  let skipped = 0
  for (const asset of payload.assets ?? []) {
    if (!asset || typeof asset.dataUrl !== 'string' || typeof asset.id !== 'string') continue
    try {
      const blob = await dataUrlToBlob(asset.dataUrl)
      if (!blob.type.startsWith('image/')) continue
      const result = await assets.ingestBlob(blob, blob.type || asset.mime)
      assetMap.set(asset.id, result.assetId)
    } catch (error) {
      console.warn('[import] asset failed', error)
    }
  }

  const imported: Item[] = []
  const noteIds = new Set<string>()
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') {
      skipped++
      continue
    }
    const record = raw as unknown as Record<string, unknown>
    const type = record.type
    const id = typeof record.id === 'string' ? record.id : ''
    if (!id) {
      skipped++
      continue
    }
    if (type === 'note') {
      const note = normalizeNote(record, id)
      imported.push(note)
      noteIds.add(id)
    } else if (type === 'text') {
      imported.push(normalizeTextItem(record, id))
    } else if (type === 'image') {
      const oldAssetId = typeof record.assetId === 'string' ? record.assetId : ''
      const newAssetId = assetMap.get(oldAssetId)
      if (!newAssetId) {
        skipped++
        continue
      }
      imported.push({
        id,
        type: 'image',
        z: 0,
        pinned: Boolean(record.pinned),
        pinnedAt: typeof record.pinnedAt === 'number' ? record.pinnedAt : null,
        deleted: false,
        groupId: normalizeGroupId(record.groupId),
        x: finite(record.x, 0),
        y: finite(record.y, 0),
        w: finite(record.w, 280, 40, 4000),
        h: finite(record.h, 210, 40, 4000),
        assetId: newAssetId,
        naturalW: finite(record.naturalW, 1, 1, 10000),
        naturalH: finite(record.naturalH, 1, 1, 10000),
      })
    } else if (type === 'stroke') {
      const stroke = normalizeStroke(record, id)
      if (stroke) imported.push(stroke)
      else skipped++
    } else if (type === 'connector') {
      const a = normalizeAnchor(record.a)
      const b = normalizeAnchor(record.b)
      if (!a || !b) {
        skipped++
        continue
      }
      imported.push({
        id,
        type: 'connector',
        z: 0,
        pinned: false,
        pinnedAt: null,
        deleted: false,
        groupId: null,
        a,
        b,
      })
    } else {
      skipped++
    }
  }
  if (!imported.length) throw new Error(t('error.importEmpty'))
  board.importItems(imported)
  if (typeof payload.title === 'string' && payload.title.trim() && !board.title()) {
    board.setTitle(payload.title.trim().slice(0, 60))
  }
  return { count: imported.length, skipped }
}

export { AssetError }
