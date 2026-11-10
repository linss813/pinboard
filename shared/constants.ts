import type { NoteAlign, NoteListStyle, NoteTextSize, StrokeStyle } from './types'

export const NOTE_COLORS = [
  '#fde68a',
  '#fca5a5',
  '#bfdbfe',
  '#a7f3d0',
  '#fdba74',
  '#e9d5ff',
  '#fbcfe8',
  '#c7d2fe',
  '#bae6fd',
  '#d9f99d',
  '#fecaca',
  '#e2e8f0',
] as const
export const PEN_COLORS = [
  '#334155',
  '#111827',
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#84cc16',
  '#10b981',
  '#14b8a6',
  '#3b82f6',
  '#6366f1',
  '#a855f7',
  '#ec4899',
] as const
export const TEXT_COLORS = [
  '#111827',
  '#334155',
  '#64748b',
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#10b981',
  '#0f766e',
  '#3b82f6',
  '#6366f1',
  '#a855f7',
  '#ec4899',
] as const
export const PEN_STYLES: readonly StrokeStyle[] = ['pen', 'marker', 'highlighter']
export const PEN_STYLE_WIDTH: Record<StrokeStyle, number> = { pen: 1, marker: 1.45, highlighter: 2.7 }
export const ERASER_SCREEN_RADIUS = 13
export const DEFAULT_PRESSURE_SENSITIVITY = 0.65
export const TEXT_SIZE_OPTIONS = [14, 18, 24, 32] as const
export const DEFAULT_TEXT_SIZE = 20
export const DEFAULT_TEXT_COLOR = '#1f2937'

export function normalizeHexColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback
}

export function readableTextColor(background: string): string {
  const hex = normalizeHexColor(background, '#ffffff')
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  return luminance > 0.46 ? '#1f2937' : '#f8fafc'
}
export const USER_COLORS = ['#e879a0', '#2fb586', '#4f8ef7', '#f59e0b', '#a855f7', '#14b8a6', '#f97316', '#ec4899'] as const

export const NOTE_TEXT_SIZES: readonly NoteTextSize[] = ['s', 'm', 'l', 'xl']
export const NOTE_TEXT_SIZE_PX: Record<NoteTextSize, number> = { s: 12, m: 14, l: 18, xl: 24 }
export const NOTE_LIST_STYLES: readonly NoteListStyle[] = ['none', 'bullet', 'ordered']
export const NOTE_ALIGNMENTS: readonly NoteAlign[] = ['left', 'center', 'right']
export const NOTE_DEFAULT_SIZE: NoteTextSize = 'm'

export const ROOM_ID_RE = /^[A-Za-z0-9_-]{16,32}$/
export const ASSET_ID_RE = /^[a-f0-9]{64}$/

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024
export const MAX_IMAGE_DIMENSION = 2560
export const IMAGE_MIME_WHITELIST = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

export const REACTIONS = ['👍', '❤️', '😂', '🎉', '👏', '❓'] as const

export const PIN = {
  drawSize: 22,
  minScreen: 16,
  maxScreen: 28,
  hitRadius: 16,
}
