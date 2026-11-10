import type {
  ConnectorItem,
  ImageItem,
  Item,
  NoteItem,
  NoteLine,
  Point,
  Rect,
  StrokeItem,
  StrokePoint,
  StrokeStyle,
  TextItem,
} from '../shared/types'
import { NOTE_DEFAULT_SIZE, NOTE_TEXT_SIZE_PX, readableTextColor } from '../shared/constants'
import {
  HANDLE_NAMES,
  connectorEndpoints,
  contentBounds,
  handlePoints,
  itemBounds,
  pinAnchor,
  screenToWorld,
  worldToScreen,
  type Camera,
  type HandleName,
} from '../shared/geometry'
import type { AssetStore } from './assets'
import { fontStack, t } from './i18n'
import { drawPin, hitPin } from './pin'
import type { Scene } from './scene'

const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif'
const STROKE_OPACITY: Record<StrokeStyle, number> = { pen: 1, marker: 0.88, highlighter: 0.34 }
const MIN_STROKE_WIDTH = 0.65

const font = (size: number, weight?: number | string): string =>
  `${weight ? `${weight} ` : ''}${size}px ${fontStack()}`

function lineFont(line: NoteLine): string {
  const size = NOTE_TEXT_SIZE_PX[line.size] ?? NOTE_TEXT_SIZE_PX[NOTE_DEFAULT_SIZE]
  return `${line.italic ? 'italic ' : ''}${line.bold ? '700 ' : ''}${size}px ${fontStack()}`
}

function fallbackLines(text: string): NoteLine[] {
  return String(text)
    .split('\n')
    .map((lineText, index) => ({
      id: `fallback-${index}`,
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

type WrapCache = Map<string, string[]>

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function isCjkChar(ch: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/.test(ch)
}

const NO_LINE_START = /^[、。，．,.!?！？：；:;）】》」』〉”’%…·\]】]/
const NO_LINE_END = /[（【《「『〈“‘\[\(]$/

function tokenize(text: string): string[] {
  const raw: string[] = []
  let latin = ''
  const flush = (): void => {
    if (latin) {
      raw.push(latin)
      latin = ''
    }
  }
  for (const ch of text) {
    if (/\s/.test(ch)) {
      flush()
      raw.push(' ')
    } else if (isCjkChar(ch)) {
      flush()
      raw.push(ch)
    } else {
      latin += ch
    }
  }
  flush()
  const merged: string[] = []
  for (const token of raw) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && token !== ' ' && (NO_LINE_START.test(token) || NO_LINE_END.test(previous))) {
      merged[merged.length - 1] = `${previous.trimEnd()}${token}`
    } else {
      merged.push(token)
    }
  }
  return merged
}

function splitLongToken(ctx: CanvasRenderingContext2D, token: string, maxWidth: number, out: string[]): string {
  let line = ''
  for (const ch of token) {
    if (line && ctx.measureText(line + ch).width > maxWidth) {
      out.push(line)
      line = ch
    } else {
      line += ch
    }
  }
  return line
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, fontSpec: string, cache?: WrapCache): string[] {
  const key = `${fontSpec}|${maxWidth}|${text}`
  if (cache?.has(key)) return cache.get(key)!
  ctx.font = fontSpec
  const out: string[] = []
  for (const raw of String(text).split('\n')) {
    const tokens = tokenize(raw)
    let line = ''
    for (const token of tokens) {
      if (token === ' ') {
        if (line) line += ' '
        continue
      }
      const candidate = line + token
      if (line && ctx.measureText(candidate).width > maxWidth) {
        out.push(line.trimEnd())
        line = ''
      }
      if (!line && ctx.measureText(token).width > maxWidth) {
        line = splitLongToken(ctx, token, maxWidth, out)
      } else {
        line = line ? line + token : token
      }
    }
    out.push(line.trimEnd())
  }
  if (cache) {
    if (cache.size > 800) cache.clear()
    cache.set(key, out)
  }
  return out
}

function drawNote(ctx: CanvasRenderingContext2D, note: NoteItem, scale: number, editing: boolean, wrapCache?: WrapCache): void {
  const radius = 8
  ctx.save()
  ctx.shadowColor = 'rgba(15,23,42,.16)'
  ctx.shadowBlur = 16 / scale
  ctx.shadowOffsetY = 4 / scale
  ctx.fillStyle = note.color
  roundRect(ctx, note.x, note.y, note.w, note.h, radius)
  ctx.fill()
  ctx.restore()

  ctx.strokeStyle = 'rgba(15,23,42,.07)'
  ctx.lineWidth = 1 / scale
  roundRect(ctx, note.x + 0.5 / scale, note.y + 0.5 / scale, note.w - 1 / scale, note.h - 1 / scale, radius)
  ctx.stroke()

  const fold = Math.min(18, note.w * 0.16, note.h * 0.16)
  ctx.fillStyle = 'rgba(15,23,42,.09)'
  ctx.beginPath()
  ctx.moveTo(note.x + note.w - fold, note.y + note.h)
  ctx.lineTo(note.x + note.w, note.y + note.h - fold)
  ctx.lineTo(note.x + note.w, note.y + note.h)
  ctx.closePath()
  ctx.fill()

  if (editing) return

  const lines = note.lines?.length ? note.lines : fallbackLines(note.text)
  const hasText = lines.some((line) => line.text.trim().length > 0)
  const padX = 12
  const padY = 11
  const ink = readableTextColor(note.color)
  if (!hasText) {
    ctx.font = font(14)
    ctx.textBaseline = 'top'
    ctx.globalAlpha = 0.48
    ctx.fillStyle = ink
    ctx.fillText(t('canvas.editHint'), note.x + padX, note.y + padY, Math.max(20, note.w - padX * 2))
    ctx.globalAlpha = 1
    return
  }

  const maxWidth = Math.max(20, note.w - padX * 2)
  const bottom = note.y + note.h - padY
  const textColor = ink
  const markerColor = ink
  let y = note.y + padY
  let orderedIndex = 0
  let truncated = false

  ctx.save()
  ctx.beginPath()
  ctx.rect(note.x + 2, note.y + 2, note.w - 4, note.h - 4)
  ctx.clip()
  ctx.textBaseline = 'top'

  outer: for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    const size = NOTE_TEXT_SIZE_PX[line.size] ?? NOTE_TEXT_SIZE_PX[NOTE_DEFAULT_SIZE]
    const lineHeight = size * 1.5
    if (line.list === 'ordered') orderedIndex += 1
    else orderedIndex = 0
    const marker = line.list === 'ordered' ? `${orderedIndex}.` : line.list === 'bullet' ? '•' : ''
    const markerFont = lineFont({ ...line, size: line.size === 'xl' ? 'l' : line.size === 'l' ? 'm' : line.size })
    let indent = 0
    let markerWidth = 0
    if (marker) {
      ctx.font = markerFont
      markerWidth = ctx.measureText(marker).width
      indent = Math.max(size * 1.15, markerWidth + size * 0.45)
    }
    const available = Math.max(12, maxWidth - indent)
    ctx.font = lineFont(line)
    const rows = wrapText(ctx, line.text, available, lineFont(line), wrapCache)
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      if (y + lineHeight > bottom + 0.5) {
        truncated = true
        break outer
      }
      if (rowIndex === 0 && marker) {
        ctx.font = markerFont
        ctx.fillStyle = markerColor
        ctx.globalAlpha = 0.68
        ctx.textAlign = 'left'
        ctx.fillText(marker, note.x + padX, y + (lineHeight - size * 1.2) / 2)
        ctx.globalAlpha = 1
      }
      const row = rows[rowIndex]
      ctx.font = lineFont(line)
      ctx.fillStyle = textColor
      const rowWidth = ctx.measureText(row).width
      let x = note.x + padX + indent
      if (!marker) {
        if (line.align === 'center') x = note.x + padX + Math.max(0, (maxWidth - rowWidth) / 2)
        else if (line.align === 'right') x = note.x + padX + Math.max(0, maxWidth - rowWidth)
      }
      ctx.textAlign = 'left'
      if (row) ctx.fillText(row, x, y)
      if (row) {
        if (line.underline) {
          ctx.fillRect(x, y + size * 1.17, rowWidth, Math.max(1, size * 0.065))
        }
        if (line.strike) {
          ctx.fillRect(x, y + size * 0.61, rowWidth, Math.max(1, size * 0.065))
        }
      }
      y += lineHeight
    }
  }
  if (truncated) {
    ctx.font = font(12, 600)
    ctx.fillStyle = 'rgba(71,85,105,.55)'
    ctx.textAlign = 'right'
    ctx.fillText('…', note.x + note.w - padX, bottom - 12)
    ctx.textAlign = 'left'
  }
  ctx.restore()
}

function drawTextItem(
  ctx: CanvasRenderingContext2D,
  item: TextItem,
  scale: number,
  editing: boolean,
  wrapCache?: WrapCache,
): void {
  if (editing) return
  const padX = 7
  const padY = 5
  const fontSize = Math.max(10, Math.min(160, item.fontSize))
  const fontSpec = font(fontSize, 400)
  const lineHeight = fontSize * 1.35
  const maxWidth = Math.max(10, item.w - padX * 2)
  ctx.save()
  ctx.beginPath()
  ctx.rect(item.x, item.y, item.w, item.h)
  ctx.clip()
  ctx.font = fontSpec
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  if (!item.text.trim()) {
    ctx.fillStyle = 'rgba(100,116,139,.45)'
    ctx.font = font(Math.max(12, Math.min(18, fontSize)), 400)
    ctx.fillText(t('canvas.textHint'), item.x + padX, item.y + padY, maxWidth)
    ctx.restore()
    return
  }
  const lines = wrapText(ctx, item.text, maxWidth, fontSpec, wrapCache)
  const maxLines = Math.max(1, Math.floor((item.h - padY * 2) / lineHeight))
  ctx.fillStyle = item.color
  for (let index = 0; index < Math.min(lines.length, maxLines); index++) {
    ctx.fillText(lines[index], item.x + padX, item.y + padY + index * lineHeight)
  }
  ctx.restore()
}

function drawImagePlaceholder(ctx: CanvasRenderingContext2D, image: ImageItem, scale: number): void {
  ctx.save()
  roundRect(ctx, image.x, image.y, image.w, image.h, 8)
  ctx.clip()
  ctx.fillStyle = '#e9eef5'
  ctx.fillRect(image.x, image.y, image.w, image.h)
  ctx.strokeStyle = '#b6c2d3'
  ctx.lineWidth = Math.max(1.2 / scale, 1)
  const cx = image.x + image.w / 2
  const cy = image.y + image.h / 2
  ctx.strokeRect(cx - 22, cy - 18, 44, 34)
  ctx.beginPath()
  ctx.arc(cx - 10, cy - 7, 3.5, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(cx - 20, cy + 12)
  ctx.lineTo(cx - 4, cy - 3)
  ctx.lineTo(cx + 7, cy + 7)
  ctx.lineTo(cx + 13, cy + 1)
  ctx.lineTo(cx + 21, cy + 12)
  ctx.stroke()
  ctx.restore()
  ctx.font = font(11 / scale)
  ctx.fillStyle = 'rgba(100,116,139,.8)'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(t('canvas.imageLoading'), image.x + image.w / 2, image.y + image.h - 14 / scale, Math.max(20, image.w - 16))
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

function drawImageItem(
  ctx: CanvasRenderingContext2D,
  image: ImageItem,
  bitmap: ImageBitmap | null,
  scale: number,
): void {
  if (!bitmap) {
    drawImagePlaceholder(ctx, image, scale)
    return
  }
  ctx.save()
  ctx.shadowColor = 'rgba(15,23,42,.16)'
  ctx.shadowBlur = 16 / scale
  ctx.shadowOffsetY = 4 / scale
  roundRect(ctx, image.x, image.y, image.w, image.h, 8)
  ctx.fillStyle = '#fff'
  ctx.fill()
  ctx.restore()

  ctx.save()
  roundRect(ctx, image.x, image.y, image.w, image.h, 8)
  ctx.clip()
  ctx.drawImage(bitmap, image.x, image.y, image.w, image.h)
  ctx.restore()

  ctx.strokeStyle = 'rgba(15,23,42,.1)'
  ctx.lineWidth = 1 / scale
  roundRect(ctx, image.x + 0.5 / scale, image.y + 0.5 / scale, image.w - 1 / scale, image.h - 1 / scale, 8)
  ctx.stroke()
}

function smoothCenterline(points: Point[], widths: number[], passes = 2): { points: Point[]; widths: number[] } {
  if (points.length < 3) return { points, widths }
  let current = points
  let currentWidths = widths
  for (let pass = 0; pass < passes; pass++) {
    const next = current.map((point) => ({ ...point }))
    const nextWidths = [...currentWidths]
    for (let index = 1; index < current.length - 1; index++) {
      next[index] = {
        x: current[index - 1].x * 0.25 + current[index].x * 0.5 + current[index + 1].x * 0.25,
        y: current[index - 1].y * 0.25 + current[index].y * 0.5 + current[index + 1].y * 0.25,
      }
      nextWidths[index] = currentWidths[index - 1] * 0.25 + currentWidths[index] * 0.5 + currentWidths[index + 1] * 0.25
    }
    current = next
    currentWidths = nextWidths
  }
  return { points: current, widths: currentWidths }
}

function chaikin(points: Point[], widths: number[], passes = 2): { points: Point[]; widths: number[] } {
  if (points.length < 3) return { points, widths }
  let current = points
  let currentWidths = widths
  for (let pass = 0; pass < passes; pass++) {
    const next: Point[] = [current[0]]
    const nextWidths: number[] = [currentWidths[0]]
    for (let index = 0; index < current.length - 1; index++) {
      const a = current[index]
      const b = current[index + 1]
      const wa = currentWidths[index]
      const wb = currentWidths[index + 1]
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 })
      nextWidths.push(wa * 0.75 + wb * 0.25)
      next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 })
      nextWidths.push(wa * 0.25 + wb * 0.75)
    }
    next.push(current[current.length - 1])
    nextWidths.push(currentWidths[currentWidths.length - 1])
    current = next
    currentWidths = nextWidths
  }
  return { points: current, widths: currentWidths }
}

function strokeWidths(stroke: StrokeItem, points: StrokePoint[], style: StrokeStyle): number[] {
  const base = Math.max(MIN_STROKE_WIDTH, stroke.width)
  if (style !== 'pen') return points.map(() => base)
  const hasPressure = points.some((point) => typeof point.pressure === 'number')
  if (!hasPressure) return points.map(() => base)
  const sensitivity = Math.max(0, Math.min(1, stroke.pressureSensitivity ?? 0.65))
  const raw = points.map((point) => {
    const pressure = Math.max(0, Math.min(1, point.pressure ?? 0.5))
    const factor = 1 + (pressure - 0.5) * 1.1 * sensitivity
    return Math.max(MIN_STROKE_WIDTH, base * factor)
  })
  return raw.map((width, index) => {
    const previous = raw[Math.max(0, index - 1)]
    const next = raw[Math.min(raw.length - 1, index + 1)]
    return previous * 0.22 + width * 0.56 + next * 0.22
  })
}

function fillStroke(ctx: CanvasRenderingContext2D, stroke: StrokeItem): void {
  const style = stroke.style ?? 'pen'
  const absolute = stroke.points.map((point) => ({
    x: point.x + stroke.x,
    y: point.y + stroke.y,
    pressure: point.pressure,
  }))
  const widths = strokeWidths(stroke, absolute, style)
  const filtered = smoothCenterline(absolute, widths, 2)
  const smoothed = chaikin(filtered.points, filtered.widths, 2)
  ctx.save()
  ctx.globalAlpha = STROKE_OPACITY[style]
  ctx.strokeStyle = stroke.color
  ctx.fillStyle = stroke.color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (smoothed.points.length === 1) {
    const point = smoothed.points[0]
    ctx.beginPath()
    ctx.arc(point.x, point.y, Math.max(MIN_STROKE_WIDTH, smoothed.widths[0]) / 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    return
  }
  const minWidth = Math.min(...smoothed.widths)
  const maxWidth = Math.max(...smoothed.widths)
  if (maxWidth - minWidth < 0.05) {
    ctx.lineWidth = maxWidth
    ctx.beginPath()
    ctx.moveTo(smoothed.points[0].x, smoothed.points[0].y)
    for (let index = 1; index < smoothed.points.length; index++) {
      ctx.lineTo(smoothed.points[index].x, smoothed.points[index].y)
    }
    ctx.stroke()
    ctx.restore()
    return
  }
  for (let index = 0; index < smoothed.points.length - 1; index++) {
    const a = smoothed.points[index]
    const b = smoothed.points[index + 1]
    ctx.lineWidth = Math.max(MIN_STROKE_WIDTH, (smoothed.widths[index] + smoothed.widths[index + 1]) / 2)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }
  ctx.restore()
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: StrokeItem): void {
  if (!stroke.points.length) return
  fillStroke(ctx, stroke)
}

function drawConnector(
  ctx: CanvasRenderingContext2D,
  connector: ConnectorItem,
  notes: Map<string, NoteItem>,
  scale: number,
  color = '#64748b',
): void {
  const ends = connectorEndpoints(connector, notes)
  if (!ends) return
  const [a, b] = ends
  const angle = Math.atan2(b.y - a.y, b.x - a.x)
  const headLen = 12 / scale
  const tip = b
  const base = {
    x: tip.x - headLen * 1.35 * Math.cos(angle),
    y: tip.y - headLen * 1.35 * Math.sin(angle),
  }
  ctx.save()
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 1.8 / scale
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(base.x, base.y)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(tip.x, tip.y)
  ctx.lineTo(tip.x - headLen * Math.cos(angle - 0.42), tip.y - headLen * Math.sin(angle - 0.42))
  ctx.lineTo(tip.x - headLen * Math.cos(angle + 0.42), tip.y - headLen * Math.sin(angle + 0.42))
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function drawPendingConnector(ctx: CanvasRenderingContext2D, pending: Scene['pendingConnect'], scale: number): void {
  if (!pending) return
  const { a, b } = pending
  const angle = Math.atan2(b.y - a.y, b.x - a.x)
  const headLen = 12 / scale
  ctx.save()
  ctx.strokeStyle = pending.valid ? '#4f8ef7' : '#94a3b8'
  ctx.fillStyle = ctx.strokeStyle
  ctx.lineWidth = 2 / scale
  ctx.setLineDash([7 / scale, 5 / scale])
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x - Math.cos(angle) * headLen, b.y - Math.sin(angle) * headLen)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.moveTo(b.x, b.y)
  ctx.lineTo(b.x - headLen * Math.cos(angle - 0.42), b.y - headLen * Math.sin(angle - 0.42))
  ctx.lineTo(b.x - headLen * Math.cos(angle + 0.42), b.y - headLen * Math.sin(angle + 0.42))
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function drawGrid(ctx: CanvasRenderingContext2D, cam: Camera, W: number, H: number): void {
  const s = cam.scale
  let step = 40
  while (step * s < 30) step *= 2
  while (step * s > 110) step /= 2
  const x0 = Math.floor(cam.x / step) * step
  const y0 = Math.floor(cam.y / step) * step
  const x1 = cam.x + W / s
  const y1 = cam.y + H / s
  ctx.lineWidth = 1 / s
  ctx.strokeStyle = 'rgba(15,23,42,.055)'
  ctx.beginPath()
  for (let x = x0; x <= x1; x += step) {
    ctx.moveTo(x, y0)
    ctx.lineTo(x, y1)
  }
  for (let y = y0; y <= y1; y += step) {
    ctx.moveTo(x0, y)
    ctx.lineTo(x1, y)
  }
  ctx.stroke()
  if (0 >= x0 - step && 0 <= x1 + step) {
    ctx.strokeStyle = 'rgba(79,142,247,.16)'
    ctx.beginPath()
    ctx.moveTo(0, y0)
    ctx.lineTo(0, y1)
    ctx.moveTo(x0, 0)
    ctx.lineTo(x1, 0)
    ctx.stroke()
  }
}

function screenRectOf(item: Item, notes: Map<string, NoteItem>, cam: Camera): Rect | null {
  const b = itemBounds(item, notes)
  if (!b.w && !b.h) return null
  const p = worldToScreen(cam, { x: b.x, y: b.y })
  return { x: p.x, y: p.y, w: b.w * cam.scale, h: b.h * cam.scale }
}

function pinVisible(item: Item, scene: Scene): boolean {
  if (item.type === 'connector') return false
  return item.pinned || scene.selection.has(item.id) || scene.hoveredId === item.id
}

function compactName(name: string): string {
  return [...name].slice(0, 12).join('')
}

export class Renderer {
  readonly ctx: CanvasRenderingContext2D
  private mmCtx: CanvasRenderingContext2D
  W = 0
  H = 0
  DPR = 1
  mmW = 210
  mmH = 146
  private mmDPR = 1
  private mmMap = { scale: 1, bx: 0, by: 0, ox: 0, oy: 0 }
  private wrapCache: WrapCache = new Map()

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly minimap: HTMLCanvasElement,
    private readonly assets: AssetStore,
    private readonly getScene: () => Scene,
  ) {
    const ctx = canvas.getContext('2d')
    const mmCtx = minimap.getContext('2d')
    if (!ctx || !mmCtx) throw new Error('Canvas 2D unavailable')
    this.ctx = ctx
    this.mmCtx = mmCtx
    this.resize()
  }

  resize(): void {
    const parent = this.canvas.parentElement
    const rect = parent?.getBoundingClientRect()
    this.W = Math.max(1, rect?.width ?? window.innerWidth)
    this.H = Math.max(1, rect?.height ?? window.innerHeight)
    this.DPR = window.devicePixelRatio || 1
    this.canvas.width = Math.round(this.W * this.DPR)
    this.canvas.height = Math.round(this.H * this.DPR)
    this.canvas.style.width = `${this.W}px`
    this.canvas.style.height = `${this.H}px`

    const mmRect = this.minimap.getBoundingClientRect()
    this.mmW = Math.max(60, mmRect.width || 210)
    this.mmH = Math.max(40, mmRect.height || 146)
    this.mmDPR = window.devicePixelRatio || 1
    this.minimap.width = Math.round(this.mmW * this.mmDPR)
    this.minimap.height = Math.round(this.mmH * this.mmDPR)
  }

  worldToScreen(point: Point): Point {
    return worldToScreen(this.getScene().camera, point)
  }

  screenToWorld(point: Point): Point {
    return screenToWorld(this.getScene().camera, point.x, point.y)
  }

  clearTextCache(): void {
    this.wrapCache.clear()
  }

  handleAt(screen: Point, item: Item): HandleName | null {
    if (!(item.type === 'note' || item.type === 'text' || item.type === 'image') || item.pinned) return null
    const rect = screenRectOf(item, this.getScene().notes, this.getScene().camera)
    if (!rect) return null
    const points = handlePoints(rect)
    for (const name of HANDLE_NAMES) {
      const p = points[name]
      if (Math.abs(screen.x - p.x) <= 8 && Math.abs(screen.y - p.y) <= 8) return name
    }
    return null
  }

  pinAt(screen: Point): string | null {
    const scene = this.getScene()
    const sorted = [...scene.items].sort((a, b) => b.z - a.z || b.id.localeCompare(a.id))
    for (const item of sorted) {
      if (!pinVisible(item, scene)) continue
      const anchor = pinAnchor(item, scene.notes)
      if (!anchor) continue
      const tip = worldToScreen(scene.camera, anchor)
      if (hitPin(screen, tip)) return item.id
    }
    return null
  }

  minimapWorldAt(clientX: number, clientY: number): Point | null {
    const rect = this.minimap.getBoundingClientRect()
    if (!this.mmMap.scale) return null
    return {
      x: (clientX - rect.left - this.mmMap.ox) / this.mmMap.scale + this.mmMap.bx,
      y: (clientY - rect.top - this.mmMap.oy) / this.mmMap.scale + this.mmMap.by,
    }
  }

  minimapScale(): number {
    return this.mmMap.scale
  }

  render(): void {
    const scene = this.getScene()
    const ctx = this.ctx
    const now = scene.now
    const cam = scene.camera
    const s = cam.scale
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0)
    ctx.clearRect(0, 0, this.W, this.H)
    ctx.fillStyle = '#f7f8fa'
    ctx.fillRect(0, 0, this.W, this.H)

    ctx.save()
    ctx.setTransform(this.DPR * s, 0, 0, this.DPR * s, -cam.x * s * this.DPR, -cam.y * s * this.DPR)
    drawGrid(ctx, cam, this.W, this.H)

    for (const item of scene.items) {
      if (item.type === 'connector') drawConnector(ctx, item, scene.notes, s)
      else if (item.type === 'stroke') drawStroke(ctx, item)
      else if (item.type === 'note') drawNote(ctx, item, s, scene.editingId === item.id, this.wrapCache)
      else if (item.type === 'text') drawTextItem(ctx, item, s, scene.editingId === item.id, this.wrapCache)
      else if (item.type === 'image') {
        drawImageItem(ctx, item, this.assets.peekBitmap(item.assetId), s)
      }
    }
    drawPendingConnector(ctx, scene.pendingConnect, s)
    ctx.restore()

    this.drawPins(scene)
    this.drawGroups(scene)
    this.drawSelection(scene)
    this.drawPeerSelections(scene)
    this.drawPeers(scene)
    this.drawLasers(scene, now)
    this.drawReactions(scene, now)
    this.drawMarquee(scene)
    this.drawLasso(scene)
    this.drawBrushPreview(scene)

    if (!scene.items.length) this.drawEmptyState()
    this.drawMinimap(scene)
  }

  private drawPins(scene: Scene): void {
    const ctx = this.ctx
    const items = [...scene.items].sort((a, b) => a.z - b.z || a.id.localeCompare(b.id))
    for (const item of items) {
      if (!pinVisible(item, scene)) continue
      const anchor = pinAnchor(item, scene.notes)
      if (!anchor) continue
      const tip = worldToScreen(scene.camera, anchor)
      drawPin(ctx, tip, {
        pinned: item.pinned,
        hovered: scene.hoveredPinId === item.id,
        ghost: !item.pinned,
      })
    }
  }

  private drawGroups(scene: Scene): void {
    const selectedGroups = new Set(
      scene.items.filter((item) => Boolean(item.groupId) && scene.selection.has(item.id)).map((item) => item.groupId),
    )
    if (!selectedGroups.size) return
    const groups = new Map<string, Item[]>()
    for (const item of scene.items) {
      if (!item.groupId || !selectedGroups.has(item.groupId)) continue
      const members = groups.get(item.groupId) ?? []
      members.push(item)
      groups.set(item.groupId, members)
    }
    const ctx = this.ctx
    for (const members of groups.values()) {
      if (members.length < 2) continue
      const bounds = contentBounds(members, scene.notes)
      if (!bounds) continue
      const p = worldToScreen(scene.camera, { x: bounds.x, y: bounds.y })
      const pad = 10
      const w = bounds.w * scene.camera.scale + pad * 2
      const h = bounds.h * scene.camera.scale + pad * 2
      ctx.save()
      ctx.fillStyle = 'rgba(79,142,247,.045)'
      ctx.strokeStyle = 'rgba(79,142,247,.72)'
      ctx.lineWidth = 1.6
      ctx.setLineDash([9, 5])
      roundRect(ctx, p.x - pad, p.y - pad, w, h, 13)
      ctx.fill()
      ctx.stroke()
      ctx.setLineDash([])
      const label = t('group.label', { n: members.length })
      ctx.font = font(10.5, 600)
      const tw = ctx.measureText(label).width
      ctx.fillStyle = 'rgba(79,142,247,.92)'
      roundRect(ctx, p.x - pad, p.y - pad - 19, tw + 14, 18, 6)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, p.x - pad + 7, p.y - pad - 9.5)
      ctx.restore()
    }
    ctx.textBaseline = 'alphabetic'
  }

  private drawSelection(scene: Scene): void {
    const ctx = this.ctx
    const selected = scene.items.filter((item) => scene.selection.has(item.id))
    if (!selected.length) return
    const notes = scene.notes
    const cam = scene.camera
    const selectedGroups = new Set(
      selected.filter((item) => Boolean(item.groupId)).map((item) => item.groupId),
    )
    const loose = selected.filter((item) => !item.groupId || !selectedGroups.has(item.groupId))
    if (loose.length) {
      const bounds = contentBounds(loose, notes)
      if (bounds) {
        const p = worldToScreen(cam, { x: bounds.x, y: bounds.y })
        const pad = 5
        const rect: Rect = { x: p.x, y: p.y, w: bounds.w * cam.scale, h: bounds.h * cam.scale }
        ctx.save()
        ctx.strokeStyle = 'rgba(79,142,247,.95)'
        ctx.lineWidth = 1.4
        ctx.setLineDash([6, 4])
        ctx.strokeRect(rect.x - pad, rect.y - pad, rect.w + pad * 2, rect.h + pad * 2)
        ctx.restore()

        if (loose.length === 1) {
          const item = loose[0]
          if ((item.type === 'note' || item.type === 'text' || item.type === 'image') && !item.pinned) {
            const points = handlePoints(rect)
            for (const name of HANDLE_NAMES) {
              const point = points[name]
              ctx.save()
              ctx.fillStyle = '#fff'
              ctx.strokeStyle = '#4f8ef7'
              ctx.lineWidth = 1.5
              ctx.beginPath()
              ctx.rect(point.x - 4, point.y - 4, 8, 8)
              ctx.fill()
              ctx.stroke()
              ctx.restore()
            }
          }
        }
      }
    }

    if (scene.flash) {
      const item = scene.items.find((it) => it.id === scene.flash!.id)
      if (item) {
        const rect = screenRectOf(item, notes, cam)
        if (rect) {
          const age = Math.max(0, nowMinus(scene.now, scene.flash.start))
          const pulse = 1 + Math.sin(age / 90) * 0.04
          ctx.save()
          ctx.strokeStyle = `rgba(79,142,247,${Math.max(0, 0.8 - age / 1200)})`
          ctx.lineWidth = 2.5
          ctx.strokeRect(
            rect.x - 10 * pulse,
            rect.y - 10 * pulse,
            rect.w + 20 * pulse,
            rect.h + 20 * pulse,
          )
          ctx.restore()
        }
      }
    }
  }

  private drawPeerSelections(scene: Scene): void {
    const ctx = this.ctx
    for (const peer of scene.peers) {
      if (!peer.selection.length) continue
      const selected = peer.selection
        .map((id) => scene.items.find((item) => item.id === id))
        .filter((item): item is Item => Boolean(item))
      const bounds = contentBounds(selected, scene.notes)
      if (!bounds) continue
      const p = worldToScreen(scene.camera, { x: bounds.x, y: bounds.y })
      ctx.save()
      ctx.strokeStyle = peer.user.color
      ctx.globalAlpha = 0.65
      ctx.lineWidth = 1.4
      ctx.strokeRect(
        p.x - 4,
        p.y - 4,
        Math.max(2, bounds.w * scene.camera.scale + 8),
        Math.max(2, bounds.h * scene.camera.scale + 8),
      )
      ctx.restore()
    }
  }

  private drawPeers(scene: Scene): void {
    const ctx = this.ctx
    for (const peer of scene.peers) {
      if (!peer.cursor) continue
      const p = worldToScreen(scene.camera, peer.cursor)
      if (p.x < -60 || p.y < -60 || p.x > this.W + 60 || p.y > this.H + 60) continue
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.fillStyle = peer.user.color
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1.3
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(0, 17)
      ctx.lineTo(4.6, 12.8)
      ctx.lineTo(8.3, 19.2)
      ctx.lineTo(11.6, 17.5)
      ctx.lineTo(7.9, 11.1)
      ctx.lineTo(13.8, 11.1)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      ctx.restore()

      const name = compactName(peer.user.name || t('avatar.guest'))
      ctx.font = font(11, 600)
      const tw = ctx.measureText(name).width
      const bx = Math.min(this.W - tw - 22, p.x + 13)
      const by = Math.min(this.H - 26, p.y + 17)
      ctx.save()
      ctx.fillStyle = peer.user.color
      roundRect(ctx, bx, by, tw + 16, 20, 6)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.textBaseline = 'middle'
      ctx.fillText(name, bx + 8, by + 10.5)
      ctx.restore()
      ctx.textBaseline = 'alphabetic'
    }
  }

  private drawLasers(scene: Scene, now: number): void {
    const ctx = this.ctx
    for (const trail of scene.lasers) {
      const points = trail.points.filter((p) => now - p.t < 900)
      if (!points.length) continue
      const screen = points.map((p) => ({ ...worldToScreen(scene.camera, p), t: p.t }))
      ctx.save()
      ctx.lineCap = 'round'
      for (let i = 1; i < screen.length; i++) {
        const age = Math.max(0, 1 - (now - screen[i].t) / 900)
        ctx.strokeStyle = `rgba(255,59,48,${0.15 + age * 0.6})`
        ctx.lineWidth = 1.5 + age * 2.5
        ctx.beginPath()
        ctx.moveTo(screen[i - 1].x, screen[i - 1].y)
        ctx.lineTo(screen[i].x, screen[i].y)
        ctx.stroke()
      }
      const last = screen[screen.length - 1]
      const age = Math.max(0, 1 - (now - last.t) / 900)
      ctx.shadowColor = 'rgba(255,45,45,.9)'
      ctx.shadowBlur = 18
      ctx.fillStyle = `rgba(255,45,45,${0.55 + age * 0.4})`
      ctx.beginPath()
      ctx.arc(last.x, last.y, 7 + age * 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.shadowBlur = 0
      ctx.fillStyle = `rgba(255,255,255,${0.75 * age})`
      ctx.beginPath()
      ctx.arc(last.x, last.y, 2.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
  }

  private drawReactions(scene: Scene, now: number): void {
    const ctx = this.ctx
    for (const reaction of scene.reactions) {
      const age = now - reaction.start
      const idle = now - reaction.updatedAt
      if (age < 0 || idle > 2600) continue
      const p = worldToScreen(scene.camera, reaction)
      const rise = Math.min(1, age / 450) * 42
      const alpha = idle < 1600 ? 1 : Math.max(0, 1 - (idle - 1600) / 1000)
      const pop = 1 + Math.exp(-idle / 160) * 0.16
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.translate(p.x + Math.sin(age / 320) * 3, p.y - 28 - rise)
      ctx.scale(pop, pop)
      ctx.font = `27px ${EMOJI_FONT}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(reaction.kind, 0, 0)
      if (reaction.count > 1) {
        const label = `×${reaction.count}`
        ctx.font = font(11, 700)
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const textWidth = ctx.measureText(label).width
        const badgeW = textWidth + 11
        const badgeH = 18
        const bx = 10
        const by = -12
        ctx.fillStyle = 'rgba(29,33,41,.94)'
        ctx.strokeStyle = 'rgba(255,255,255,.92)'
        ctx.lineWidth = 1.4
        roundRect(ctx, bx, by, badgeW, badgeH, 9)
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = '#fff'
        ctx.fillText(label, bx + badgeW / 2, by + badgeH / 2 + 0.5)
      }
      ctx.restore()
    }
  }

  private drawMarquee(scene: Scene): void {
    if (!scene.marquee) return
    const m = scene.marquee
    const ctx = this.ctx
    ctx.save()
    ctx.fillStyle = 'rgba(79,142,247,.08)'
    ctx.strokeStyle = 'rgba(79,142,247,.8)'
    ctx.lineWidth = 1
    ctx.setLineDash([5, 4])
    ctx.fillRect(m.x, m.y, m.w, m.h)
    ctx.strokeRect(m.x + 0.5, m.y + 0.5, m.w, m.h)
    ctx.restore()
  }

  private drawBrushPreview(scene: Scene): void {
    const brush = scene.brushPreview
    if (!brush) return
    const ctx = this.ctx
    ctx.save()
    ctx.beginPath()
    ctx.arc(brush.x, brush.y, brush.radius, 0, Math.PI * 2)
    if (brush.eraser) {
      ctx.fillStyle = 'rgba(255,255,255,.65)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(51,65,85,.82)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 3])
      ctx.stroke()
      ctx.setLineDash([])
    } else {
      ctx.globalAlpha = Math.min(0.25, brush.opacity * 0.22)
      ctx.fillStyle = brush.color
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.strokeStyle = 'rgba(255,255,255,.92)'
      ctx.lineWidth = 3
      ctx.stroke()
      ctx.strokeStyle = brush.color
      ctx.globalAlpha = brush.opacity
      ctx.lineWidth = 1.4
      ctx.beginPath()
      ctx.arc(brush.x, brush.y, Math.max(1.5, brush.radius), 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    ctx.beginPath()
    ctx.arc(brush.x, brush.y, 1.4, 0, Math.PI * 2)
    ctx.fillStyle = brush.eraser ? 'rgba(51,65,85,.8)' : 'rgba(255,255,255,.9)'
    ctx.fill()
    ctx.restore()
  }

  private drawLasso(scene: Scene): void {
    const points = scene.lasso
    if (!points || points.length < 2) return
    const ctx = this.ctx
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
    ctx.closePath()
    ctx.fillStyle = 'rgba(79,142,247,.07)'
    ctx.strokeStyle = 'rgba(79,142,247,.86)'
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.setLineDash([7, 4])
    ctx.fill()
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(255,255,255,.95)'
    ctx.strokeStyle = 'rgba(79,142,247,.9)'
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.arc(points[0].x, points[0].y, 3.2, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }

  private drawEmptyState(): void {
    const ctx = this.ctx
    ctx.save()
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(71,85,105,.5)'
    ctx.font = font(15, 600)
    ctx.fillText(t('canvas.emptyTitle'), this.W / 2, this.H / 2 - 8, Math.max(200, this.W - 48))
    ctx.font = font(12)
    ctx.fillStyle = 'rgba(100,116,139,.5)'
    ctx.fillText(t('canvas.emptySubtitle'), this.W / 2, this.H / 2 + 18, Math.max(200, this.W - 48))
    ctx.restore()
  }

  private drawMinimap(scene: Scene): void {
    const ctx = this.mmCtx
    ctx.setTransform(this.mmDPR, 0, 0, this.mmDPR, 0, 0)
    ctx.clearRect(0, 0, this.mmW, this.mmH)
    ctx.fillStyle = '#fdfdfe'
    ctx.fillRect(0, 0, this.mmW, this.mmH)

    const b = contentBounds(scene.items, scene.notes)
    const view = {
      x: scene.camera.x,
      y: scene.camera.y,
      w: this.W / scene.camera.scale,
      h: this.H / scene.camera.scale,
    }
    const margin = 100
    const bounds = b
      ? {
          x: Math.min(b.x, view.x) - margin,
          y: Math.min(b.y, view.y) - margin,
          w: Math.max(b.x + b.w, view.x + view.w) - Math.min(b.x, view.x) + margin * 2,
          h: Math.max(b.y + b.h, view.y + view.h) - Math.min(b.y, view.y) + margin * 2,
        }
      : { x: view.x - margin, y: view.y - margin, w: view.w + margin * 2, h: view.h + margin * 2 }
    const pad = 10
    const k = Math.min((this.mmW - pad * 2) / bounds.w, (this.mmH - pad * 2) / bounds.h)
    const ox = (this.mmW - bounds.w * k) / 2
    const oy = (this.mmH - bounds.h * k) / 2
    this.mmMap = { scale: k, bx: bounds.x, by: bounds.y, ox, oy }
    const mp = (x: number, y: number): Point => ({ x: ox + (x - bounds.x) * k, y: oy + (y - bounds.y) * k })

    for (const item of scene.items) {
      if (item.type === 'note') {
        const p = mp(item.x, item.y)
        ctx.fillStyle = item.color
        ctx.fillRect(p.x, p.y, Math.max(2, item.w * k), Math.max(2, item.h * k))
      } else if (item.type === 'text') {
        const p = mp(item.x, item.y)
        ctx.fillStyle = '#cbd5e1'
        ctx.fillRect(p.x, p.y, Math.max(2, item.w * k), Math.max(1.5, item.h * k))
      } else if (item.type === 'image') {
        const p = mp(item.x, item.y)
        ctx.fillStyle = '#dbe3ee'
        ctx.fillRect(p.x, p.y, Math.max(2, item.w * k), Math.max(2, item.h * k))
      } else if (item.type === 'stroke') {
        ctx.strokeStyle = '#c3cad6'
        ctx.lineWidth = 1
        ctx.beginPath()
        item.points.forEach((pt, i) => {
          const q = mp(pt.x + item.x, pt.y + item.y)
          if (i) ctx.lineTo(q.x, q.y)
          else ctx.moveTo(q.x, q.y)
        })
        ctx.stroke()
      } else {
        const ends = connectorEndpoints(item, scene.notes)
        if (!ends) continue
        const a = mp(ends[0].x, ends[0].y)
        const c = mp(ends[1].x, ends[1].y)
        ctx.strokeStyle = '#d5dce5'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(c.x, c.y)
        ctx.stroke()
      }
    }

    const v = mp(view.x, view.y)
    ctx.strokeStyle = '#4f8ef7'
    ctx.lineWidth = 1.3
    ctx.strokeRect(v.x, v.y, view.w * k, view.h * k)
    ctx.fillStyle = 'rgba(79,142,247,.08)'
    ctx.fillRect(v.x, v.y, view.w * k, view.h * k)
  }
}

function nowMinus(now: number, then: number): number {
  return Math.max(0, now - then)
}

export async function renderBoardToPng(
  items: Item[],
  notes: Map<string, NoteItem>,
  assets: AssetStore,
): Promise<Blob | null> {
  const bounds = contentBounds(items, notes)
  if (!bounds) return null
  const padding = 70
  let pixelScale = 2
  let width = Math.ceil((bounds.w + padding * 2) * pixelScale)
  let height = Math.ceil((bounds.h + padding * 2) * pixelScale)
  const maxDim = 8192
  if (Math.max(width, height) > maxDim) {
    const k = maxDim / Math.max(width, height)
    pixelScale *= k
    width = Math.ceil((bounds.w + padding * 2) * pixelScale)
    height = Math.ceil((bounds.h + padding * 2) * pixelScale)
  }
  const imageIds = items.filter((i): i is ImageItem => i.type === 'image').map((i) => i.assetId)
  await assets.ensureAll(imageIds)

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#f7f8fa'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const cam: Camera = {
    x: bounds.x - padding,
    y: bounds.y - padding,
    scale: pixelScale,
  }
  ctx.save()
  ctx.setTransform(pixelScale, 0, 0, pixelScale, -cam.x * pixelScale, -cam.y * pixelScale)
  const wrapCache: WrapCache = new Map()
  for (const item of items) {
    if (item.type === 'connector') drawConnector(ctx, item, notes, pixelScale)
    else if (item.type === 'stroke') drawStroke(ctx, item)
    else if (item.type === 'note') drawNote(ctx, item, pixelScale, false, wrapCache)
    else if (item.type === 'text') drawTextItem(ctx, item, pixelScale, false, wrapCache)
    else drawImageItem(ctx, item, assets.peekBitmap(item.assetId), pixelScale)
  }
  ctx.restore()

  for (const item of [...items].sort((a, b) => a.z - b.z)) {
    if (item.type === 'connector' || !item.pinned) continue
    const anchor = pinAnchor(item, notes)
    if (!anchor) continue
    const tip = worldToScreen(cam, anchor)
    drawPin(ctx, tip, { pinned: true, size: 24 })
  }
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'))
}
