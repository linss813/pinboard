export type Point = { x: number; y: number }
export type StrokePoint = Point & { pressure?: number }
export type Rect = { x: number; y: number; w: number; h: number }

export type ItemType = 'note' | 'text' | 'image' | 'stroke' | 'connector'
export type Anchor = { noteId: string } | Point
export type StrokeStyle = 'pen' | 'marker' | 'highlighter'

export type NoteTextSize = 's' | 'm' | 'l' | 'xl'
export type NoteListStyle = 'none' | 'bullet' | 'ordered'
export type NoteAlign = 'left' | 'center' | 'right'

export interface NoteLine {
  id: string
  text: string
  size: NoteTextSize
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  list: NoteListStyle
  align: NoteAlign
}

export interface ItemBase {
  id: string
  type: ItemType
  z: number
  pinned: boolean
  pinnedAt: number | null
  deleted: boolean
  groupId?: string | null
}

export interface NoteItem extends ItemBase {
  type: 'note'
  x: number
  y: number
  w: number
  h: number
  color: string
  text: string
  lines?: NoteLine[]
}

export interface TextItem extends ItemBase {
  type: 'text'
  x: number
  y: number
  w: number
  h: number
  text: string
  color: string
  fontSize: number
}

export interface ImageItem extends ItemBase {
  type: 'image'
  x: number
  y: number
  w: number
  h: number
  assetId: string
  naturalW: number
  naturalH: number
}

export interface StrokeItem extends ItemBase {
  type: 'stroke'
  x: number
  y: number
  points: StrokePoint[]
  color: string
  width: number
  style?: StrokeStyle
  pressureSensitivity?: number
}

export interface ConnectorItem extends ItemBase {
  type: 'connector'
  a: Anchor
  b: Anchor
}

export type Item = NoteItem | TextItem | ImageItem | StrokeItem | ConnectorItem
export type PinnableItem = NoteItem | TextItem | ImageItem | StrokeItem
export type BoxItem = NoteItem | TextItem | ImageItem

export function isNote(item: Item): item is NoteItem {
  return item.type === 'note'
}

export function isText(item: Item): item is TextItem {
  return item.type === 'text'
}

export function isImage(item: Item): item is ImageItem {
  return item.type === 'image'
}

export function isStroke(item: Item): item is StrokeItem {
  return item.type === 'stroke'
}

export function isConnector(item: Item): item is ConnectorItem {
  return item.type === 'connector'
}

export function isPinnable(item: Item): item is PinnableItem {
  return item.type !== 'connector'
}

export interface PeerUser {
  id: string
  name: string
  color: string
}

export interface PeerView {
  cx: number
  cy: number
  scale: number
}

export interface ReactionEvent {
  id: string
  kind: string
  x: number
  y: number
  ts: number
  count?: number
}

export interface PresenceState {
  user?: PeerUser
  cursor?: Point | null
  view?: PeerView
  selection?: string[]
  editingId?: string | null
  followingId?: string | null
  laser?: { x: number; y: number; ts: number } | null
  reaction?: ReactionEvent | null
}

export interface AssetPayload {
  id: string
  mime: string
  dataUrl: string
}

export interface ExportFile {
  format: 'pinboard'
  version: 1
  title: string
  exportedAt: string
  items: Item[]
  assets: AssetPayload[]
}
