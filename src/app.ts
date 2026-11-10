import * as Y from 'yjs'
import { Board, type SeedContent } from './board'
import { AssetStore } from './assets'
import { Renderer } from './renderer'
import { NoteEditor } from './editor'
import { TextBoxEditor } from './text-editor'
import { PresenceManager, storedName, type PeerSnapshot } from './presence'
import * as UI from './ui'
import type { FlashState, FloatingReaction, Scene, Tool } from './scene'
import type { Anchor, BoxItem, Item, NoteItem, PeerUser, Point, Rect, StrokePoint, StrokeStyle, TextItem } from '../shared/types'
import {
  clamp,
  contentBounds,
  fitCameraToBounds,
  itemBounds,
  pointInPolygon,
  pointInRect,
  rectsIntersect,
  screenToWorld,
  topItemAt,
  worldToScreen,
  zoomCameraAt,
  type Camera,
  type HandleName,
} from '../shared/geometry'
import {
  DEFAULT_PRESSURE_SENSITIVITY,
  DEFAULT_TEXT_COLOR,
  DEFAULT_TEXT_SIZE,
  ERASER_SCREEN_RADIUS,
  NOTE_COLORS,
  PEN_COLORS,
  PEN_STYLE_WIDTH,
  REACTIONS,
  TEXT_COLORS,
} from '../shared/constants'
import { copyText, isEditableTarget, isProbablyImageFile, randomRoomId, uuid } from './util'
import { exportJson, exportPng, importJson } from './exchange'
import { onLocaleChange, setLocale, t, type Locale } from './i18n'

type Drag =
  | { kind: 'pan'; start: Point; cam: Camera }
  | { kind: 'marquee'; start: Point; current: Point; base: Set<string> }
  | { kind: 'lasso'; points: Point[]; base: Set<string> }
  | { kind: 'move'; ids: string[]; last: Point; mixedPinned: boolean; warned: boolean; moved: boolean }
  | { kind: 'resize'; id: string; handle: HandleName; orig: Rect; start: Point; ratio: number }
  | { kind: 'draw'; id: string; last: Point }
  | { kind: 'erase'; last: Point }
  | { kind: 'connect'; a: Anchor; aPoint: Point; b: Point; targetId: string | null; valid: boolean; moved: boolean }

interface CameraAnimation {
  from: Camera
  to: Camera
  start: number
  duration: number
}

function resolveRoomId(): string {
  const match = /^\/r\/([A-Za-z0-9_-]{16,32})\/?$/.exec(location.pathname)
  if (match) return match[1]
  const id = randomRoomId()
  history.replaceState(null, '', `/r/${id}`)
  return id
}

function pointFromEvent(event: MouseEvent | PointerEvent, element: HTMLElement): Point {
  const rect = element.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function resizeCursor(handle: HandleName): string {
  if (handle === 'nw' || handle === 'se') return 'nwse-resize'
  if (handle === 'ne' || handle === 'sw') return 'nesw-resize'
  if (handle === 'e' || handle === 'w') return 'ew-resize'
  return 'ns-resize'
}

export class App {
  readonly roomId: string
  readonly doc: Y.Doc
  readonly board: Board
  readonly assets: AssetStore
  readonly presence: PresenceManager
  readonly renderer: Renderer
  readonly editor: NoteEditor
  readonly textEditor: TextBoxEditor

  camera: Camera = { x: 0, y: 0, scale: 1 }
  tool: Tool = 'select'
  selection = new Set<string>()
  hoveredId: string | null = null
  hoveredPinId: string | null = null
  editingId: string | null = null
  flash: FlashState | null = null
  followId: string | null = null
  spaceDown = false

  private drag: Drag | null = null
  private reactions: FloatingReaction[] = []
  private localLaser: { x: number; y: number; t: number }[] = []
  private tempLaserPrevious: Tool | null = null
  private penColor: string = PEN_COLORS[0]
  private penWidth = 4
  private penStyle: StrokeStyle = 'pen'
  private pressureSensitivity = DEFAULT_PRESSURE_SENSITIVITY
  private noteColor: string = NOTE_COLORS[0]
  private textColor: string = DEFAULT_TEXT_COLOR
  private textSize: number = DEFAULT_TEXT_SIZE
  private clipboard: Item[] = []
  private pasteCount = 0
  private pointerScreen: Point = { x: 0, y: 0 }
  private pointerWorld: Point = { x: 0, y: 0 }
  private pointerOnCanvas = false
  private cameraAnimation: CameraAnimation | null = null
  private renderPending = true
  private lastTick = performance.now()
  private cameraInitialized = false
  private userTouchedCamera = false
  private synced = false
  private connection: 'connecting' | 'connected' | 'disconnected' = 'connecting'
  private panelTimer: ReturnType<typeof setTimeout> | null = null
  private titleTimer: ReturnType<typeof setTimeout> | null = null
  private dropDepth = 0
  private reactionAnchor: Point | null = null
  private reactionBurst: { id: string; kind: string; count: number; x: number; y: number } | null = null
  private reactionLimitNotified = false
  private longPressTimer: ReturnType<typeof setTimeout> | null = null
  private longPressScreen: Point | null = null
  private longPressPointerId: number | null = null
  private minimapVisible = true
  private doubleClickEditsNote = false
  private hasCustomName = Boolean(storedName())
  private pendingShareCopy = false

  private readonly minimapSensitivity = 0.35
  private readonly longCapture = 10_000
  private readonly shortCapture = 350

  constructor() {
    this.roomId = resolveRoomId()
    try {
      this.doubleClickEditsNote = localStorage.getItem('pinboard-dbl-edit') === '1'
      const rawPressure = localStorage.getItem('pinboard-pressure')
      if (rawPressure !== null) {
        const storedPressure = Number(rawPressure)
        if (Number.isFinite(storedPressure) && storedPressure >= 0 && storedPressure <= 1) {
          this.pressureSensitivity = storedPressure
        }
      }
    } catch {
      // storage may be unavailable
    }
    this.doc = new Y.Doc()
    this.board = new Board(this.doc)
    this.assets = new AssetStore(this.roomId)
    this.assets.setOnChange(() => {
      this.requestRender()
      this.schedulePinnedRefresh()
    })

    this.presence = new PresenceManager(this.doc, this.roomId, {
      onChange: () => this.requestRender(),
      onPeerList: (peers) => this.onPeersChanged(peers),
      onReaction: (reaction, color) => {
        const now = performance.now()
        const count = Math.max(1, Math.min(99, Math.round(reaction.count ?? 1)))
        const existing = this.reactions.find((item) => item.id === reaction.id)
        if (existing) {
          existing.kind = reaction.kind
          existing.x = reaction.x
          existing.y = reaction.y
          existing.count = count
          existing.updatedAt = now
          existing.color = color
        } else {
          this.reactions.push({
            id: reaction.id,
            kind: reaction.kind,
            x: reaction.x,
            y: reaction.y,
            start: now,
            updatedAt: now,
            count,
            color,
          })
        }
        this.requestRender()
      },
      onStatus: (status) => {
        this.connection = status
        this.refreshConnection()
      },
      onSync: (synced) => {
        this.synced = synced
        this.refreshConnection()
        if (synced) this.onSynced()
      },
      onLocalPersisted: () => {
        if (!this.cameraInitialized) this.initializeCameraIfNeeded(false)
      },
    })

    this.renderer = new Renderer(UI.dom.canvas, UI.dom.minimap, this.assets, () => this.scene())
    this.editor = new NoteEditor({
      board: this.board,
      element: UI.dom.editor,
      formatBar: UI.dom.formatBar,
      getCamera: () => this.camera,
      getItem: (id) => {
        const item = this.board.item(id)
        return item && item.type === 'note' && !item.deleted ? item : null
      },
      onOpen: (id) => {
        this.editingId = id
        this.selection = new Set([id])
        this.presence.setEditingId(id)
        this.presence.setSelection([...this.selection])
        this.requestRender()
        this.schedulePinnedRefresh()
      },
      onClose: () => {
        this.editingId = null
        this.presence.setEditingId(null)
        UI.dom.canvas.focus({ preventScroll: true })
        this.requestRender()
      },
      requestRender: () => this.requestRender(),
      undo: () => this.doUndo(),
      redo: () => this.doRedo(),
      toast: (message) => this.toast(message),
    })

    this.textEditor = new TextBoxEditor({
      board: this.board,
      textarea: UI.dom.textEditor,
      getCamera: () => this.camera,
      getItem: (id) => {
        const item = this.board.item(id)
        return item && item.type === 'text' && !item.deleted ? item : null
      },
      onOpen: (id) => {
        this.editingId = id
        this.selection = new Set([id])
        this.presence.setEditingId(id)
        this.presence.setSelection([...this.selection])
        UI.hideSelectionBar()
        this.requestRender()
        this.schedulePinnedRefresh()
      },
      onClose: () => {
        this.editingId = null
        this.presence.setEditingId(null)
        UI.dom.canvas.focus({ preventScroll: true })
        this.requestRender()
      },
      requestRender: () => this.requestRender(),
      undo: () => this.doUndo(),
      redo: () => this.doRedo(),
      toast: (message) => this.toast(message),
    })

    this.board.subscribe(() => this.onBoardChange())
    this.bindToolbar()
    this.bindHeaderActions()
    this.bindLanguageSwitch()
    this.bindCanvasEvents()
    this.bindKeyboard()
    this.bindDropAndPaste()
    this.bindResize()
    this.bindNetworkEvents()
    this.bindNameForm()
    this.initMinimapVisibility()
    onLocaleChange(() => this.onLocaleChanged())

    UI.setRoomId(this.roomId)
    this.syncTitleFromBoard()
    this.centerCamera(false)
    this.refreshPeerUi()
    this.refreshConnection()
    UI.setZoom(this.camera.scale)
    this.refreshPinSummary()
    this.initNameGate()
    this.requestRender()
    if (typeof document !== 'undefined' && document.fonts) {
      void document.fonts.ready.then(() => {
        this.renderer.clearTextCache()
        this.requestRender()
      })
    }
    requestAnimationFrame(this.tick)
  }

  private bindLanguageSwitch(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-lang]').forEach((button) => {
      button.addEventListener('click', () => {
        const locale = button.dataset.lang as Locale | undefined
        if (!locale) return
        setLocale(locale)
        UI.hideMenu()
      })
    })
  }

  private onLocaleChanged(): void {
    if (!this.hasCustomName) {
      this.presence.setEphemeralName(this.guestName())
      this.refreshPeerUi()
    }
    if (this.textEditor.isOpen()) UI.dom.textEditor.placeholder = t('editor.textPlaceholder')
    if (UI.isNameModalVisible()) UI.configureNameModal('share')
    this.refreshConnection()
    this.syncTitleFromBoard()
    this.refreshPeerUi()
    this.refreshPinSummary()
    if (UI.isPinnedPanelOpen()) this.renderPinnedPanel()
    UI.buildReactionPalette((kind) => this.selectReaction(kind))
    UI.hideReactionPalette()
    this.reactionBurst = null
    this.reactionAnchor = null
    UI.buildGuide()
    UI.hideContextMenu()
    this.requestRender()
  }

  /* ------------------------------------------------------------------ */
  /* scene / render                                                      */
  /* ------------------------------------------------------------------ */

  private scene(): Scene {
    const now = performance.now()
    const localPoints = this.localLaser.filter((p) => now - p.t < 1000)
    const lasers = this.presence.pruneLasers(now)
    if (localPoints.length) {
      lasers.push({
        clientId: 'local',
        color: '#ff3b30',
        points: localPoints.map((p) => ({ ...p })),
      })
    }
    return {
      camera: this.camera,
      items: this.board.visibleItems(),
      notes: this.board.visibleNotes(),
      selection: this.selection,
      hoveredId: this.hoveredId,
      hoveredPinId: this.hoveredPinId,
      editingId: this.editingId,
      marquee: this.currentMarquee(),
      lasso: this.currentLasso(),
      brushPreview: this.currentBrushPreview(),
      pendingConnect: this.currentPendingConnect(),
      peers: this.presence.currentPeers,
      lasers,
      reactions: this.reactions,
      flash: this.flash,
      followId: this.followId,
      selectionDrag: this.drag?.kind === 'move' || this.drag?.kind === 'resize',
      now,
    }
  }

  private currentMarquee(): Rect | null {
    if (this.drag?.kind !== 'marquee') return null
    const a = this.drag.start
    const b = this.drag.current
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x),
      h: Math.abs(a.y - b.y),
    }
  }

  private currentPendingConnect(): Scene['pendingConnect'] {
    if (this.drag?.kind !== 'connect') return null
    return {
      a: this.drag.aPoint,
      b: this.drag.b,
      targetId: this.drag.targetId,
      valid: this.drag.valid,
    }
  }

  private currentLasso(): Point[] | null {
    return this.drag?.kind === 'lasso' ? this.drag.points : null
  }

  private strokeWidthForStyle(style: StrokeStyle = this.penStyle): number {
    return this.penWidth * PEN_STYLE_WIDTH[style]
  }

  private currentBrushPreview(): Scene['brushPreview'] {
    if (!this.pointerOnCanvas || this.editingId || this.spaceDown) return null
    if (this.drag?.kind === 'pan') return null
    if (UI.isNameModalVisible() || UI.isGuideOpen() || UI.isSettingsOpen()) return null
    if (this.tool === 'eraser') {
      return {
        x: this.pointerScreen.x,
        y: this.pointerScreen.y,
        radius: ERASER_SCREEN_RADIUS,
        color: '#64748b',
        opacity: 1,
        eraser: true,
      }
    }
    if (this.tool !== 'pen') return null
    const radius = Math.max(2, Math.min(90, (this.strokeWidthForStyle() * this.camera.scale) / 2))
    return {
      x: this.pointerScreen.x,
      y: this.pointerScreen.y,
      radius,
      color: this.penColor,
      opacity: this.penStyle === 'pen' ? 0.9 : this.penStyle === 'marker' ? 0.7 : 0.42,
      eraser: false,
    }
  }

  private requestRender(): void {
    this.renderPending = true
  }

  private render(): void {
    this.renderer.render()
    this.updateTextOptions()
    this.updateSelectionBar()
  }

  private updateTextOptions(): void {
    const items = this.selectedItems()
    const singleText = items.length === 1 && items[0].type === 'text' ? items[0] : null
    const visible =
      !this.editingId && !this.drag && (this.tool === 'text' || (this.tool === 'select' && Boolean(singleText)))
    UI.setTextOptionsVisible(visible)
    if (!singleText || !visible) return
    this.textColor = singleText.color
    this.textSize = singleText.fontSize
    UI.setSwatchSelection(UI.dom.textSwatches, TEXT_COLORS, singleText.color)
    UI.dom.textCustomColor.value = singleText.color
    UI.dom.textSizes.querySelectorAll<HTMLElement>('[data-text-size]').forEach((node) => {
      node.classList.toggle('active', Number(node.dataset.textSize) === singleText.fontSize)
    })
  }

  private updateSelectionBar(): void {
    if ((this.tool !== 'select' && this.tool !== 'lasso') || this.editingId || this.drag) {
      UI.hideSelectionBar()
      return
    }
    const items = this.selectedItems()
    if (!items.length) {
      UI.hideSelectionBar()
      return
    }
    const bounds = contentBounds(items, this.board.visibleNotes())
    if (!bounds) {
      UI.hideSelectionBar()
      return
    }
    const p = worldToScreen(this.camera, { x: bounds.x, y: bounds.y })
    const rect: Rect = {
      x: p.x,
      y: p.y,
      w: bounds.w * this.camera.scale,
      h: bounds.h * this.camera.scale,
    }
    if (items.length === 1) {
      const single = items[0]
      if (single.type === 'note') {
        UI.setSwatchSelection(UI.dom.noteSwatches, NOTE_COLORS, single.color)
        UI.dom.noteCustomColor.value = single.color
      } else if (single.type === 'text') {
        this.textColor = single.color
        this.textSize = single.fontSize
        UI.setSwatchSelection(UI.dom.textSwatches, TEXT_COLORS, single.color)
        UI.dom.textCustomColor.value = single.color
        UI.dom.textSizes.querySelectorAll<HTMLElement>('[data-text-size]').forEach((node) => {
          node.classList.toggle('active', Number(node.dataset.textSize) === single.fontSize)
        })
      }
    }
    const pinnable = items.filter((i) => i.type !== 'connector')
    const allPinned = pinnable.length > 0 && pinnable.every((i) => i.pinned)
    const hasDeletable = items.some((item) => !item.pinned)
    const groupable = pinnable.length >= 2
    const groupIds = new Set(pinnable.map((item) => item.groupId).filter(Boolean))
    const canUngroup = groupIds.size > 0
    UI.showSelectionBar(rect, {
      pinLabel: allPinned ? t('action.unpin') : t('action.pin'),
      pinDisabled: pinnable.length === 0,
      pinActive: allPinned,
      deleteDisabled: !hasDeletable,
      canDelete: true,
      editVisible: items.length === 1 && (items[0].type === 'note' || items[0].type === 'text'),
      editTitle: items[0]?.type === 'text' ? t('selection.editTextTitle') : t('selection.editTitle'),
      groupLabel: canUngroup ? t('selection.ungroup') : t('selection.group'),
      groupDisabled: !groupable && !canUngroup,
      groupIsUngroup: canUngroup,
    })
  }

  private tick = (now: number): void => {
    const dt = Math.min(0.08, Math.max(0.001, (now - this.lastTick) / 1000))
    this.lastTick = now
    this.tickFollow(dt)
    this.tickCameraAnimation(now)
    this.tickTransients(now)
    if (this.renderPending) {
      this.renderPending = false
      this.render()
    }
    requestAnimationFrame(this.tick)
  }

  private tickTransients(now: number): void {
    let active = false
    if (!UI.isReactionPaletteOpen() && this.reactionBurst) {
      this.reactionBurst = null
      this.reactionAnchor = null
      this.reactionLimitNotified = false
    }
    const oldLaser = this.localLaser.length
    this.localLaser = this.localLaser.filter((p) => now - p.t < 1000)
    if (this.localLaser.length || oldLaser) active = oldLaser > 0
    if (this.presence.pruneLasers(now).length) active = true

    if (this.reactions.length) {
      const before = this.reactions.length
      this.reactions = this.reactions.filter((r) => now - r.updatedAt < 2600)
      if (this.reactions.length || before !== this.reactions.length) active = true
    }
    if (this.flash) {
      if (now >= this.flash.until) {
        this.flash = null
        this.requestRender()
      } else {
        active = true
      }
    }
    if (active) this.requestRender()
  }

  /* ------------------------------------------------------------------ */
  /* pin helpers                                                         */
  /* ------------------------------------------------------------------ */

  private refreshPinSummary(): void {
    const count = this.board
      .visibleItems()
      .filter((item) => item.pinned && item.type !== 'connector').length
    UI.updatePinCount(count)
  }

  private schedulePinnedRefresh(): void {
    if (!UI.isPinnedPanelOpen()) return
    if (this.panelTimer) clearTimeout(this.panelTimer)
    this.panelTimer = setTimeout(() => {
      this.panelTimer = null
      this.renderPinnedPanel()
    }, 80)
  }

  private renderPinnedPanel(): void {
    const notes = this.board.visibleNotes()
    UI.renderPinnedList({
      items: this.board.visibleItems(),
      notes,
      search: UI.dom.pinSearch.value,
      assets: this.assets,
      onLocate: (id) => this.locateItem(id),
      onUnpin: (id) => {
        const result = this.board.togglePin([id])
        if (result) {
          this.toast(result.pinned ? t('toast.pinned') : t('toast.unpinned'))
          this.board.stopCapturing()
        }
      },
      onHover: (id) => {
        this.hoveredId = id
        this.requestRender()
      },
    })
  }

  private togglePinPanel(open = !UI.isPinnedPanelOpen()): void {
    UI.setPinnedPanel(open)
    if (open) {
      this.renderPinnedPanel()
    }
  }

  private togglePinOnSelection(ids = [...this.selection]): void {
    if (!ids.length) {
      this.toast(t('toast.pinNoSelection'))
      return
    }
    this.board.stopCapturing()
    const result = this.board.togglePin(ids)
    this.board.stopCapturing()
    if (!result) {
      this.toast(t('toast.pinConnector'))
      return
    }
    this.toast(result.pinned ? t('toast.pinned') : t('toast.unpinned'))
    this.requestRender()
  }

  private handlePinClick(id: string): void {
    this.selection = new Set([id])
    this.presence.setSelection([id])
    this.board.stopCapturing()
    const result = this.board.togglePin([id])
    this.board.stopCapturing()
    if (result) this.toast(result.pinned ? t('toast.pinned') : t('toast.unpinned'))
    this.requestRender()
  }

  /* ------------------------------------------------------------------ */
  /* board change                                                        */
  /* ------------------------------------------------------------------ */

  private onBoardChange(): void {
    const items = this.board.visibleItems()
    const byId = new Map(items.map((i) => [i.id, i]))

    if (this.editingId && !byId.has(this.editingId)) {
      this.closeEditors(false)
      this.toast(t('toast.editingDeleted'))
    }

    let selectionChanged = false
    for (const id of [...this.selection]) {
      if (!byId.has(id)) {
        this.selection.delete(id)
        selectionChanged = true
      }
    }
    if (selectionChanged) this.presence.setSelection([...this.selection])

    if (this.drag?.kind === 'move') {
      const allGone = this.drag.ids.every((id) => !byId.has(id))
      const nowPinned = this.drag.ids.some((id) => byId.get(id)?.pinned)
      if (allGone) this.drag = null
      else if (nowPinned) {
        this.drag = null
        this.endGesture()
        this.toast(t('toast.remotePinnedMove'))
      }
    }
    if (this.drag?.kind === 'resize') {
      const item = byId.get(this.drag.id)
      if (!item || item.pinned) {
        this.drag = null
        this.endGesture()
        if (item?.pinned) this.toast(t('toast.lockedResize'))
      }
    }

    this.refreshPinSummary()
    this.schedulePinnedRefresh()
    this.syncTitleFromBoard()
    this.editor.reposition()
    this.textEditor.reposition()
    this.requestRender()
  }

  /* ------------------------------------------------------------------ */
  /* selection                                                           */
  /* ------------------------------------------------------------------ */

  private selectedItems(): Item[] {
    return this.board.visibleItems().filter((item) => this.selection.has(item.id))
  }

  private setSelection(ids: string[], broadcast = true, expandGroups = true): void {
    const visibleIds = new Set(this.board.visibleItems().map((i) => i.id))
    const expanded = expandGroups ? this.board.expandGroups(ids) : ids
    const next = new Set(expanded.filter((id) => visibleIds.has(id)))
    const same = next.size === this.selection.size && [...next].every((id) => this.selection.has(id))
    this.selection = next
    if (broadcast) this.presence.setSelection([...next])
    if (!same) this.requestRender()
  }

  private toggleSelection(ids: string[], additive: boolean): void {
    const visible = this.board.visibleItems()
    const byId = new Map(visible.map((item) => [item.id, item]))
    const targets = new Set<string>()
    for (const id of ids) {
      const item = byId.get(id)
      if (!item) continue
      const members = item.groupId ? visible.filter((member) => member.groupId === item.groupId) : [item]
      for (const member of members) targets.add(member.id)
    }
    if (!additive) {
      this.setSelection([...targets])
      return
    }
    const allSelected = [...targets].every((id) => this.selection.has(id))
    const next = new Set(this.selection)
    for (const id of targets) {
      if (allSelected) next.delete(id)
      else next.add(id)
    }
    this.setSelection([...next], true, false)
  }

  private selectionGroupInfo(): { grouped: boolean; canGroup: boolean } {
    const items = this.selectedItems().filter((item) => item.type !== 'connector')
    const groupIds = new Set(items.map((item) => item.groupId).filter(Boolean))
    return { grouped: groupIds.size > 0, canGroup: items.length >= 2 }
  }

  private groupSelection(): void {
    const groupId = this.board.groupItems([...this.selection])
    this.board.stopCapturing()
    if (!groupId) {
      this.toast(t('toast.groupNone'))
      return
    }
    this.toast(t('toast.grouped'))
    this.requestRender()
  }

  private ungroupSelection(): void {
    const changed = this.board.ungroupItems([...this.selection])
    this.board.stopCapturing()
    if (!changed) {
      this.toast(t('toast.ungroupNone'))
      return
    }
    this.toast(t('toast.ungrouped'))
    this.requestRender()
  }

  private toggleGroupSelection(): void {
    if (this.selectionGroupInfo().grouped) this.ungroupSelection()
    else this.groupSelection()
  }

  private clearSelection(): void {
    if (!this.selection.size) return
    this.selection = new Set()
    this.presence.setSelection([])
    this.requestRender()
  }

  /* ------------------------------------------------------------------ */
  /* tools & toolbar                                                     */
  /* ------------------------------------------------------------------ */

  private setTool(tool: Tool): void {
    const previous = this.tool
    if (previous === 'laser' && tool !== 'laser') {
      this.presence.sendLaser(null)
      this.syncLaserUi()
    }
    this.tool = tool
    this.hoveredPinId = null
    this.hoveredId = null
    UI.setToolUi(tool)
    if (tool !== 'select' && tool !== 'lasso') UI.hideSelectionBar()
    this.setCanvasCursor()
    this.requestRender()
  }

  private syncLaserUi(): void {
    // UI state is derived from the active tool; nothing else to update.
  }

  private setPenStyle(style: StrokeStyle): void {
    this.penStyle = style
    UI.dom.penModes.querySelectorAll<HTMLElement>('[data-pen-style]').forEach((button) => {
      const active = button.dataset.penStyle === style
      button.classList.toggle('active', active)
      button.setAttribute('aria-pressed', String(active))
    })
    UI.dom.penPressureControl.hidden = style !== 'pen'
    this.requestRender()
  }

  private bindToolbar(): void {
    UI.buildSwatches(UI.dom.penSwatches, PEN_COLORS, this.penColor, (color) => {
      this.penColor = color
      UI.dom.penCustomColor.value = color
      this.requestRender()
    })
    UI.dom.penCustomColor.value = this.penColor
    UI.dom.penCustomColor.addEventListener('input', () => {
      this.penColor = UI.dom.penCustomColor.value
      UI.dom.penSwatches.querySelectorAll('.sw').forEach((swatch) => swatch.classList.remove('on'))
      this.requestRender()
    })
    UI.dom.penModes.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-pen-style]')
      const style = button?.dataset.penStyle as StrokeStyle | undefined
      if (style) this.setPenStyle(style)
    })
    UI.dom.penPressure.value = String(Math.round(this.pressureSensitivity * 100))
    UI.dom.penPressureLabel.textContent = `${Math.round(this.pressureSensitivity * 100)}%`
    UI.dom.penPressure.addEventListener('input', () => {
      this.pressureSensitivity = Number(UI.dom.penPressure.value) / 100
      UI.dom.penPressureLabel.textContent = `${Math.round(this.pressureSensitivity * 100)}%`
      try {
        localStorage.setItem('pinboard-pressure', String(this.pressureSensitivity))
      } catch {
        // storage may be unavailable
      }
    })
    UI.buildSwatches(UI.dom.noteSwatches, NOTE_COLORS, this.noteColor, (color) => {
      this.noteColor = color
      UI.dom.noteCustomColor.value = color
      const selectedNotes = this.selectedItems().filter((i): i is NoteItem => i.type === 'note')
      for (const note of selectedNotes) this.board.setNoteColor(note.id, color)
      this.requestRender()
    })
    UI.dom.noteCustomColor.value = this.noteColor
    UI.dom.noteCustomColor.addEventListener('input', () => {
      this.noteColor = UI.dom.noteCustomColor.value
      UI.dom.noteSwatches.querySelectorAll('.sw').forEach((swatch) => swatch.classList.remove('on'))
      const selectedNotes = this.selectedItems().filter((i): i is NoteItem => i.type === 'note')
      for (const note of selectedNotes) this.board.setNoteColor(note.id, this.noteColor)
      this.requestRender()
    })
    UI.buildSwatches(UI.dom.textSwatches, TEXT_COLORS, this.textColor, (color) => {
      this.textColor = color
      UI.dom.textCustomColor.value = color
      const selectedTexts = this.selectedItems().filter((i): i is TextItem => i.type === 'text')
      for (const item of selectedTexts) this.board.setTextColor(item.id, color)
      this.requestRender()
    })
    UI.dom.textCustomColor.value = this.textColor
    UI.dom.textCustomColor.addEventListener('input', () => {
      this.textColor = UI.dom.textCustomColor.value
      UI.dom.textSwatches.querySelectorAll('.sw').forEach((swatch) => swatch.classList.remove('on'))
      const selectedTexts = this.selectedItems().filter((i): i is TextItem => i.type === 'text')
      for (const item of selectedTexts) this.board.setTextColor(item.id, this.textColor)
      this.requestRender()
    })
    UI.dom.textSizes.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-text-size]')
      const size = Number(button?.dataset.textSize)
      if (!Number.isFinite(size) || size <= 0) return
      this.textSize = size
      UI.dom.textSizes.querySelectorAll<HTMLElement>('[data-text-size]').forEach((node) => {
        node.classList.toggle('active', Number(node.dataset.textSize) === size)
      })
      const selectedTexts = this.selectedItems().filter((i): i is TextItem => i.type === 'text')
      for (const item of selectedTexts) this.board.setTextSize(item.id, size)
      this.requestRender()
    })
    UI.dom.penWidth.addEventListener('input', () => {
      this.penWidth = Number(UI.dom.penWidth.value)
      UI.dom.penWidthLabel.textContent = String(this.penWidth)
      this.requestRender()
    })
    this.setPenStyle(this.penStyle)
    UI.dom.toolbar.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('.tbtn')
      if (!button) return
      const action = button.dataset.action
      if (action === 'image') {
        this.openImagePicker()
        return
      }
      const tool = button.dataset.tool as Tool | undefined
      if (tool) this.setTool(tool)
    })
  }

  /* ------------------------------------------------------------------ */
  /* header & popovers                                                   */
  /* ------------------------------------------------------------------ */

  private bindHeaderActions(): void {
    UI.dom.btnPinPanel.addEventListener('click', () => this.togglePinPanel())
    UI.dom.btnClosePanel.addEventListener('click', () => this.togglePinPanel(false))
    UI.dom.pinSearch.addEventListener('input', () => this.renderPinnedPanel())
    UI.dom.btnShare.addEventListener('click', () => this.copyShareLink())
    UI.dom.btnCloseName.addEventListener('click', () => this.cancelNamePrompt())
    UI.dom.nameModal.addEventListener('click', (event) => {
      if (event.target === UI.dom.nameModal) this.cancelNamePrompt()
    })
    UI.dom.btnMenu.addEventListener('click', () => UI.toggleMenu())
    UI.dom.btnReactions.addEventListener('click', (event) => {
      event.stopPropagation()
      if (UI.isReactionPaletteOpen()) this.closeReactionPalette()
      else this.openReactionPaletteFromButton()
    })
    UI.buildReactionPalette((kind) => this.selectReaction(kind))
    UI.dom.btnGuide.addEventListener('click', () => this.toggleGuide())
    UI.dom.btnCloseGuide.addEventListener('click', () => UI.setGuideVisible(false))
    UI.dom.guideModal.addEventListener('click', (event) => {
      if (event.target === UI.dom.guideModal) UI.setGuideVisible(false)
    })
    UI.dom.btnMinimapToggle.addEventListener('click', () => this.setMinimapVisible(false))
    UI.dom.btnMinimapShow.addEventListener('click', () => this.setMinimapVisible(true))
    UI.dom.btnCloseSettings.addEventListener('click', () => UI.setSettingsVisible(false))
    UI.dom.settingsModal.addEventListener('click', (event) => {
      if (event.target === UI.dom.settingsModal) UI.setSettingsVisible(false)
    })
    UI.dom.optDoubleClick.addEventListener('change', () => {
      this.setDoubleClickEdit(UI.dom.optDoubleClick.checked)
    })
    UI.dom.optMinimap.addEventListener('change', () => {
      this.setMinimapVisible(UI.dom.optMinimap.checked)
    })
    UI.dom.zoomIn.addEventListener('click', () => {
      this.zoomAtCenter(1.25)
    })
    UI.dom.zoomOut.addEventListener('click', () => {
      this.zoomAtCenter(0.8)
    })
    UI.dom.zoomFit.addEventListener('click', () => this.fitAll(true))
    UI.dom.zoomLabel.addEventListener('click', () => this.fitAll(true))
    UI.dom.btnStopFollow.addEventListener('click', () => this.stopFollow(false))
    UI.dom.connState.addEventListener('click', () => {
      this.presence.retryConnection()
      this.toast(t('toast.reconnecting'))
    })

    UI.dom.roomTitle.addEventListener('input', () => {
      if (this.titleTimer) clearTimeout(this.titleTimer)
      this.titleTimer = setTimeout(() => {
        this.titleTimer = null
        this.board.setTitle(UI.dom.roomTitle.value)
        this.updatePageTitle()
      }, 280)
    })
    UI.dom.roomTitle.addEventListener('blur', () => {
      if (this.titleTimer) {
        clearTimeout(this.titleTimer)
        this.titleTimer = null
      }
      this.board.setTitle(UI.dom.roomTitle.value)
      this.updatePageTitle()
    })
    UI.dom.roomTitle.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') {
        event.preventDefault()
        UI.dom.roomTitle.blur()
      }
      if (event.key === 'Escape') {
        UI.dom.roomTitle.value = this.board.title()
        UI.dom.roomTitle.blur()
      }
    })

    UI.dom.selectionBar.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-sel-action]')
      if (!button) return
      const action = button.dataset.selAction
      if (action === 'edit') this.editSelection()
      else if (action === 'pin') this.togglePinOnSelection()
      else if (action === 'group') this.toggleGroupSelection()
      else if (action === 'duplicate') this.duplicateSelection()
      else if (action === 'front') {
        this.board.bringToFront([...this.selection])
        this.board.stopCapturing()
      } else if (action === 'back') {
        this.board.sendToBack([...this.selection])
        this.board.stopCapturing()
      } else if (action === 'delete') this.deleteSelection()
    })

    UI.dom.menu.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-menu-action]')
      if (!button) return
      const action = button.dataset.menuAction
      UI.hideMenu()
      if (action === 'undo') this.doUndo()
      else if (action === 'redo') this.doRedo()
      else if (action === 'guide') this.toggleGuide()
      else if (action === 'settings') this.openSettings()
      else if (action === 'export-png') void this.exportPngFile()
      else if (action === 'export-json') void this.exportJsonFile()
      else if (action === 'import-json') UI.dom.jsonInput.click()
      else if (action === 'new-room') this.createNewRoom()
      else if (action === 'copy-link') this.copyShareLink()
    })

    UI.dom.fileInput.addEventListener('change', () => {
      const files = UI.dom.fileInput.files ? [...UI.dom.fileInput.files] : []
      UI.dom.fileInput.value = ''
      if (files.length) void this.addImages(files)
    })
    UI.dom.jsonInput.addEventListener('change', () => {
      const file = UI.dom.jsonInput.files?.[0]
      UI.dom.jsonInput.value = ''
      if (file) void this.importJsonFile(file)
    })

    this.bindContextMenuActions()
  }

  private bindContextMenuActions(): void {
    // The menu is rebuilt per invocation; listeners are attached in openContextMenu.
  }

  private openContextMenu(screen: Point, clientX: number, clientY: number): void {
    const item = this.itemAtScreen(screen)
    if (!item) {
      UI.hideContextMenu()
      return
    }
    if (!this.selection.has(item.id)) {
      this.setSelection([item.id])
    }
    const selected = this.selectedItems()
    const pinnable = selected.filter((i) => i.type !== 'connector')
    const allPinned = pinnable.length > 0 && pinnable.every((i) => i.pinned)
    const anyPinned = pinnable.some((i) => i.pinned)
    const groupInfo = this.selectionGroupInfo()
    const hasDeletable = selected.some((item) => !item.pinned)
    const label =
      item.type === 'note'
        ? t('context.note')
        : item.type === 'text'
          ? t('context.text')
          : item.type === 'image'
            ? t('context.image')
            : item.type === 'stroke'
              ? t('context.stroke')
              : t('context.connector')
    const color =
      selected.length === 1 && item.type === 'note'
        ? {
            current: item.color,
            colors: NOTE_COLORS,
            allowCustom: true,
            onPick: (value: string) => {
              this.board.setNoteColor(item.id, value)
              this.requestRender()
            },
          }
        : selected.length === 1 && item.type === 'text'
          ? {
              current: item.color,
              colors: TEXT_COLORS,
              allowCustom: true,
              onPick: (value: string) => {
                this.board.setTextColor(item.id, value)
                this.requestRender()
              },
            }
          : undefined
    UI.showContextMenu({
      x: clientX,
      y: clientY,
      title: label,
      color,
      actions: [
        ...(selected.length === 1 && (item.type === 'note' || item.type === 'text')
          ? [
              {
                label: item.type === 'text' ? t('context.editText') : t('context.edit'),
                hint: 'Enter',
                action: () => this.editSelection(),
              },
            ]
          : []),
        ...(pinnable.length
          ? [
              {
                label: allPinned ? t('action.unpin') : t('action.pin'),
                hint: 'Shift+P',
                icon: UI.icons.pinOffIcon,
                action: () => this.togglePinOnSelection([...this.selection]),
              },
            ]
          : []),
        {
          label: t('context.duplicate'),
          hint: 'Ctrl+D',
          disabled: selected.every((i) => i.type === 'connector'),
          action: () => this.duplicateSelection(),
        },
        {
          label: groupInfo.grouped ? t('context.ungroup') : t('context.group'),
          hint: 'Ctrl+G',
          disabled: !groupInfo.canGroup && !groupInfo.grouped,
          action: () => this.toggleGroupSelection(),
        },
        {
          label: t('context.front'),
          action: () => {
            this.board.bringToFront([...this.selection])
            this.board.stopCapturing()
          },
        },
        {
          label: t('context.back'),
          action: () => {
            this.board.sendToBack([...this.selection])
            this.board.stopCapturing()
          },
        },
        {
          label: t('context.delete'),
          hint: !hasDeletable ? t('context.deleteLocked') : anyPinned ? t('context.deleteSkipsPinned') : 'Delete',
          danger: true,
          disabled: !hasDeletable,
          action: () => this.deleteSelection(),
        },
      ],
    })
  }

  /* ------------------------------------------------------------------ */
  /* name & presence UI                                                 */
  /* ------------------------------------------------------------------ */

  private bindNameForm(): void {
    UI.dom.nameForm.addEventListener('submit', (event) => {
      event.preventDefault()
      const name = UI.dom.nameInput.value.trim()
      if (!name) {
        UI.dom.nameInput.focus()
        return
      }
      const shouldShare = this.pendingShareCopy
      this.pendingShareCopy = false
      this.hasCustomName = true
      this.presence.setUserName(name)
      UI.setNameModalVisible(false)
      UI.dom.canvas.focus({ preventScroll: true })
      this.refreshPeerUi()
      this.presence.setSelection([...this.selection])
      this.presence.setEditingId(this.editingId)
      this.presence.updateView(this.viewOfCamera())
      this.sendCursorNow()
      this.requestRender()
      if (shouldShare) void this.performCopyShareLink()
      else this.toast(t('toast.welcome', { name }))
    })
  }

  private initNameGate(): void {
    UI.setRoomId(this.roomId)
    if (!this.hasCustomName) {
      this.presence.setEphemeralName(this.guestName())
      this.refreshPeerUi()
    }
    UI.setNameModalVisible(false)
  }

  private guestName(): string {
    const code = this.presence.id.replace(/-/g, '').slice(0, 4).toUpperCase()
    return t('guestName', { code })
  }

  private openShareNamePrompt(): void {
    this.pendingShareCopy = true
    UI.hideMenu()
    UI.hideContextMenu()
    this.closeReactionPalette()
    UI.configureNameModal('share')
    UI.dom.nameInput.value = this.presence.name || this.guestName()
    UI.setNameModalVisible(true)
  }

  private cancelNamePrompt(): void {
    if (!UI.isNameModalVisible()) return
    this.pendingShareCopy = false
    UI.setNameModalVisible(false)
    UI.dom.canvas.focus({ preventScroll: true })
  }

  private onPeersChanged(_peers: PeerSnapshot[]): void {
    this.refreshPeerUi()
    if (this.followId && !this.presence.followedPeer(this.followId)) {
      this.stopFollow(true, t('follow.left'))
      return
    }
    if (this.followId) {
      const peer = this.presence.followedPeer(this.followId)
      if (peer) this.showFollowBanner(peer.user)
    }
    this.requestRender()
  }

  private refreshPeerUi(): void {
    const peers = this.presence.peerList.map((p) => p.user)
    UI.renderAvatars(this.presence.self, peers, this.followId, (userId) => this.toggleFollow(userId))
    const following = this.followId
      ? this.presence.peerList.find((p) => p.user.id === this.followId)
      : null
    this.showFollowBanner(following?.user ?? null)
  }

  private showFollowBanner(user: PeerUser | null): void {
    UI.showFollowBanner(user)
  }

  private viewOfCamera(): { cx: number; cy: number; scale: number } {
    return {
      cx: this.camera.x + this.renderer.W / (2 * this.camera.scale),
      cy: this.camera.y + this.renderer.H / (2 * this.camera.scale),
      scale: this.camera.scale,
    }
  }

  private refreshConnection(): void {
    if (this.connection === 'disconnected') UI.setConnection('offline', t('conn.offline'))
    else if (this.connection === 'connecting') UI.setConnection('waiting', t('conn.connecting'))
    else UI.setConnection(this.synced ? 'online' : 'waiting', this.synced ? t('conn.synced') : t('conn.connected'))
    UI.dom.connState.title = t('conn.retry')
  }

  private onSynced(): void {
    const seeded = this.board.seedIfEmpty(this.seedContent())
    this.syncTitleFromBoard()
    this.refreshPinSummary()
    if (!this.cameraInitialized || (!this.userTouchedCamera && seeded)) {
      this.initializeCameraIfNeeded(true)
    }
    void this.assets.retryPending()
    void this.assets.ensureAll(
      this.board
        .visibleItems()
        .filter((i) => i.type === 'image')
        .map((i) => (i as { assetId: string }).assetId),
    )
    this.requestRender()
  }

  private seedContent(): SeedContent {
    return {
      title: t('seed.title'),
      welcome: t('seed.welcome'),
      pin: t('seed.pin'),
      laser: t('seed.laser'),
    }
  }

  private initializeCameraIfNeeded(force: boolean): void {
    if (this.cameraInitialized && (this.userTouchedCamera || !force)) return
    const items = this.board.visibleItems()
    const notes = this.board.visibleNotes()
    const bounds = contentBounds(items, notes)
    if (bounds) {
      const cam = fitCameraToBounds(bounds, this.renderer.W, this.renderer.H, 0.88, 1.5)
      this.applyCamera(cam, false)
    } else {
      this.centerCamera(false)
    }
    this.cameraInitialized = true
    this.presence.updateView(this.viewOfCamera())
    this.requestRender()
  }

  private toggleFollow(userId: string): void {
    if (!this.presence.name) {
      this.toast(t('toast.setName'))
      return
    }
    if (this.followId === userId) {
      this.stopFollow(false)
      return
    }
    const check = this.presence.canFollow(userId)
    if (!check.ok) {
      this.toast(check.reason ?? t('follow.cannot'))
      return
    }
    if (this.followId) this.stopFollow(false)
    this.followId = userId
    this.presence.setFollowing(userId)
    this.refreshPeerUi()
    this.toast(t('follow.started', { name: check.user?.name ?? t('avatar.guest') }))
    this.requestRender()
  }

  private stopFollow(notify: boolean, message?: string): void {
    if (!this.followId) return
    this.followId = null
    this.presence.setFollowing(null)
    this.showFollowBanner(null)
    this.refreshPeerUi()
    if (notify) this.toast(message ?? t('follow.stopped'))
    this.requestRender()
  }

  private tickFollow(dt: number): void {
    if (!this.followId) return
    const peer = this.presence.followedPeer(this.followId)
    if (!peer) {
      this.stopFollow(true, t('follow.left'))
      return
    }
    const view = peer.state.view
    const cursor = peer.state.cursor
    if (!view && !cursor) return
    const targetScale = view ? clamp(view.scale, 0.1, 4) : this.camera.scale
    const cx = view ? view.cx : cursor!.x
    const cy = view ? view.cy : cursor!.y
    const targetCam: Camera = {
      scale: targetScale,
      x: cx - this.renderer.W / (2 * targetScale),
      y: cy - this.renderer.H / (2 * targetScale),
    }
    const factor = 1 - Math.exp(-7 * dt)
    const next: Camera = {
      scale: this.camera.scale + (targetCam.scale - this.camera.scale) * factor,
      x: this.camera.x + (targetCam.x - this.camera.x) * factor,
      y: this.camera.y + (targetCam.y - this.camera.y) * factor,
    }
    const moved =
      Math.abs(next.x - this.camera.x) > 0.05 ||
      Math.abs(next.y - this.camera.y) > 0.05 ||
      Math.abs(next.scale - this.camera.scale) > 0.0005
    if (moved) this.applyCamera(next, false)
  }

  private tickCameraAnimation(now: number): void {
    if (!this.cameraAnimation) return
    const { from, to, start, duration } = this.cameraAnimation
    const t = clamp((now - start) / duration, 0, 1)
    const ease = 1 - Math.pow(1 - t, 3)
    const next: Camera = {
      x: from.x + (to.x - from.x) * ease,
      y: from.y + (to.y - from.y) * ease,
      scale: from.scale + (to.scale - from.scale) * ease,
    }
    this.applyCamera(next, false)
    if (t >= 1) this.cameraAnimation = null
  }

  private applyCamera(next: Camera, markUser: boolean): void {
    if (markUser) {
      this.userTouchedCamera = true
      this.cameraAnimation = null
      if (this.followId) this.stopFollow(false)
      if (UI.isReactionPaletteOpen()) this.closeReactionPalette()
    }
    this.camera = { ...next, scale: clamp(next.scale, 0.1, 4) }
    UI.setZoom(this.camera.scale)
    this.presence.updateView(this.viewOfCamera())
    this.updateCursorForCamera()
    this.editor.reposition()
    this.textEditor.reposition()
    this.requestRender()
  }

  private setCamera(next: Camera): void {
    this.applyCamera(next, true)
  }

  private updateCursorForCamera(): void {
    if (!this.pointerOnCanvas) return
    const world = screenToWorld(this.camera, this.pointerScreen.x, this.pointerScreen.y)
    this.pointerWorld = world
    this.presence.updateCursor(world)
  }

  private sendCursorNow(): void {
    if (!this.pointerOnCanvas) {
      this.presence.updateCursor(null, true)
      return
    }
    const world = screenToWorld(this.camera, this.pointerScreen.x, this.pointerScreen.y)
    this.presence.updateCursor(world, true)
  }

  private zoomAtCenter(factor: number): void {
    const p = { x: this.renderer.W / 2, y: this.renderer.H / 2 }
    this.setCamera(zoomCameraAt(this.camera, p.x, p.y, factor))
  }

  private fitAll(markUser: boolean): void {
    this.cameraAnimation = null
    if (markUser && this.followId) this.stopFollow(false)
    const items = this.board.visibleItems()
    const notes = this.board.visibleNotes()
    const bounds = contentBounds(items, notes)
    if (!bounds) {
      this.centerCamera(markUser)
      return
    }
    const cam = fitCameraToBounds(bounds, this.renderer.W, this.renderer.H, 0.9, 1.5)
    this.applyCamera(cam, markUser)
    if (markUser) this.userTouchedCamera = true
  }

  private centerCamera(markUser: boolean): void {
    this.applyCamera(
      {
        x: -this.renderer.W / 2,
        y: -this.renderer.H / 2,
        scale: 1,
      },
      markUser,
    )
  }

  private locateItem(id: string): void {
    const item = this.board.item(id)
    if (!item || item.deleted) return
    this.setSelection([id])
    this.stopFollow(false)
    this.cameraAnimation = null
    const bounds = itemBounds(item, this.board.visibleNotes())
    const pad = 120
    const targetScale = clamp(
      Math.min(
        (this.renderer.W - pad * 2) / Math.max(60, bounds.w),
        (this.renderer.H - pad * 2) / Math.max(60, bounds.h),
      ),
      0.3,
      1.6,
    )
    const cx = bounds.x + bounds.w / 2
    const cy = bounds.y + bounds.h / 2
    const to: Camera = {
      scale: targetScale,
      x: cx - this.renderer.W / (2 * targetScale),
      y: cy - this.renderer.H / (2 * targetScale),
    }
    this.flash = { id, start: performance.now(), until: performance.now() + 1300 }
    this.userTouchedCamera = false
    this.cameraAnimation = { from: { ...this.camera }, to, start: performance.now(), duration: 380 }
    this.requestRender()
  }

  /* ------------------------------------------------------------------ */
  /* pointer helpers                                                     */
  /* ------------------------------------------------------------------ */

  private itemAtScreen(screen: Point): Item | null {
    const world = screenToWorld(this.camera, screen.x, screen.y)
    return topItemAt(this.board.visibleItems(), world, this.board.visibleNotes(), 4 / this.camera.scale)
  }

  private noteAtScreen(screen: Point): NoteItem | null {
    const world = screenToWorld(this.camera, screen.x, screen.y)
    const notes = [...this.board.visibleNotes().values()].sort((a, b) => b.z - a.z)
    return (
      notes.find((note) => pointInRect(world, { x: note.x, y: note.y, w: note.w, h: note.h })) ?? null
    )
  }

  private singleSelectedBox(): BoxItem | null {
    if (this.selection.size !== 1) return null
    const item = this.board.item([...this.selection][0])
    if (!item || item.deleted) return null
    return item.type === 'note' || item.type === 'text' || item.type === 'image' ? item : null
  }

  private beginGesture(): void {
    this.board.stopCapturing()
    this.board.undoManager.captureTimeout = this.longCapture
  }

  private endGesture(): void {
    this.board.stopCapturing()
    this.board.undoManager.captureTimeout = this.shortCapture
  }

  private pressureFromEvent(event: PointerEvent | MouseEvent): number | undefined {
    const pointer = event as PointerEvent
    if (pointer.pointerType !== 'pen') return undefined
    if (!Number.isFinite(pointer.pressure)) return undefined
    return clamp(pointer.pressure, 0.02, 1)
  }

  private eraseStrokesAt(world: Point): string[] {
    const tolerance = ERASER_SCREEN_RADIUS / this.camera.scale
    const item = topItemAt(this.board.visibleItems(), world, this.board.visibleNotes(), tolerance)
    if (!item || item.type !== 'stroke' || item.pinned) return []
    const result = this.board.deleteItems([item.id])
    return result.ok ? result.deleted : []
  }

  private eraseStrokesAlong(from: Point, to: Point): boolean {
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    const step = Math.max(2, (ERASER_SCREEN_RADIUS * 0.55) / this.camera.scale)
    const count = Math.max(1, Math.ceil(distance / step))
    let changed = false
    for (let index = 1; index <= count; index++) {
      const t = index / count
      const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
      if (this.eraseStrokesAt(point).length) changed = true
    }
    return changed
  }

  private startLongPress(pointerId: number, screen: Point): void {
    this.cancelLongPress()
    this.longPressPointerId = pointerId
    this.longPressScreen = screen
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null
      const pressed = this.longPressScreen
      const id = this.longPressPointerId
      this.longPressScreen = null
      this.longPressPointerId = null
      if (!pressed || this.drag?.kind !== 'marquee') return
      this.drag = null
      if (id !== null && UI.dom.canvas.hasPointerCapture(id)) {
        UI.dom.canvas.releasePointerCapture(id)
      }
      const rect = UI.dom.canvas.getBoundingClientRect()
      this.openReactionPaletteAt(pressed, { x: rect.left + pressed.x, y: rect.top + pressed.y })
      UI.hideSelectionBar()
      this.setCanvasCursor()
      this.requestRender()
    }, 480)
  }

  private cancelLongPress(): void {
    if (this.longPressTimer) clearTimeout(this.longPressTimer)
    this.longPressTimer = null
    this.longPressScreen = null
    this.longPressPointerId = null
  }

  private setCanvasCursor(over?: HTMLElement): void {
    const canvas = UI.dom.canvas
    if (this.drag?.kind === 'pan' || this.spaceDown) {
      canvas.style.cursor = 'grabbing'
      return
    }
    if (this.drag?.kind === 'resize') {
      canvas.style.cursor = resizeCursor(this.drag.handle)
      return
    }
    if (this.tool === 'note') {
      canvas.style.cursor = 'copy'
      return
    }
    if (this.tool === 'text') {
      canvas.style.cursor = 'text'
      return
    }
    if (this.tool === 'lasso') {
      canvas.style.cursor = 'crosshair'
      return
    }
    if (this.tool === 'pen' || this.tool === 'eraser') {
      canvas.style.cursor = 'none'
      return
    }
    if (this.tool === 'connect' || this.tool === 'laser') {
      canvas.style.cursor = 'crosshair'
      return
    }
    void over
    canvas.style.cursor = 'default'
  }

  /* ------------------------------------------------------------------ */
  /* canvas events                                                       */
  /* ------------------------------------------------------------------ */

  private bindCanvasEvents(): void {
    const canvas = UI.dom.canvas
    canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event))
    canvas.addEventListener('pointermove', (event) => this.onPointerMove(event))
    canvas.addEventListener('pointerup', (event) => this.onPointerUp(event))
    canvas.addEventListener('pointercancel', (event) => this.onPointerUp(event))
    canvas.addEventListener('pointerleave', () => {
      if (!this.drag) {
        this.pointerOnCanvas = false
        this.hoveredId = null
        this.hoveredPinId = null
        this.presence.updateCursor(null, true)
        this.presence.sendLaser(null)
        this.requestRender()
      }
    })
    canvas.addEventListener('dblclick', (event) => this.onDoubleClick(event))
    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      const screen = pointFromEvent(event, canvas)
      this.openContextMenu(screen, event.clientX, event.clientY)
    })
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        const screen = pointFromEvent(event, canvas)
        const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.renderer.H : 1
        if (event.ctrlKey || event.metaKey) {
          this.setCamera(zoomCameraAt(this.camera, screen.x, screen.y, Math.exp(-event.deltaY * lines * 0.0018)))
        } else {
          this.setCamera({
            ...this.camera,
            x: this.camera.x + (event.deltaX * lines) / this.camera.scale,
            y: this.camera.y + (event.deltaY * lines) / this.camera.scale,
          })
        }
      },
      { passive: false },
    )

    this.bindMinimap()
  }

  private onPointerDown(event: PointerEvent): void {
    if (UI.isNameModalVisible()) return
    const screen = pointFromEvent(event, UI.dom.canvas)
    this.pointerScreen = screen
    this.pointerOnCanvas = true
    this.pointerWorld = screenToWorld(this.camera, screen.x, screen.y)
    UI.dom.canvas.focus({ preventScroll: true })
    this.presence.updateCursor(this.pointerWorld, true)
    if (event.button === 2) return

    this.cancelLongPress()
    UI.hideContextMenu()
    UI.hideReactionPalette()
    UI.hideMenu()
    if (this.editingId) this.closeEditors(true)
    this.setCanvasCursor()

    if (event.button === 1 || this.spaceDown) {
      event.preventDefault()
      this.drag = { kind: 'pan', start: screen, cam: { ...this.camera } }
      this.cameraAnimation = null
      if (this.followId) this.stopFollow(false)
      UI.dom.canvas.setPointerCapture(event.pointerId)
      this.setCanvasCursor()
      return
    }
    if (event.button !== 0) return

    if (event.altKey) {
      event.preventDefault()
      const rect = UI.dom.canvas.getBoundingClientRect()
      this.openReactionPaletteAt(screen, { x: rect.left + screen.x, y: rect.top + screen.y })
      return
    }

    if (this.tool === 'laser') {
      event.preventDefault()
      this.updateLaser(this.pointerWorld)
      return
    }

    if (this.tool === 'note') {
      event.preventDefault()
      this.beginGesture()
      const noteColor = this.noteColor
      const id = this.board.createNote(
        { x: this.pointerWorld.x - 90, y: this.pointerWorld.y - 90, w: 180, h: 180 },
        noteColor,
      )
      this.endGesture()
      this.setSelection([id])
      this.setTool('select')
      this.openNoteEditor(id)
      this.requestRender()
      return
    }

    if (this.tool === 'text') {
      event.preventDefault()
      this.beginGesture()
      const id = this.board.createText(
        {
          x: this.pointerWorld.x,
          y: this.pointerWorld.y,
          w: 260,
          h: Math.max(52, this.textSize * 2.2),
        },
        this.textColor,
        this.textSize,
      )
      this.endGesture()
      this.setSelection([id])
      this.setTool('select')
      this.openTextEditor(id)
      this.requestRender()
      return
    }

    if (this.tool === 'lasso') {
      event.preventDefault()
      this.cancelLongPress()
      UI.hideSelectionBar()
      const base = event.shiftKey ? new Set(this.selection) : new Set<string>()
      if (!event.shiftKey) this.setSelection([])
      this.drag = { kind: 'lasso', points: [screen], base }
      UI.dom.canvas.setPointerCapture(event.pointerId)
      this.requestRender()
      return
    }

    if (this.tool === 'eraser') {
      event.preventDefault()
      this.beginGesture()
      this.eraseStrokesAt(this.pointerWorld)
      this.drag = { kind: 'erase', last: { ...this.pointerWorld } }
      UI.dom.canvas.setPointerCapture(event.pointerId)
      this.requestRender()
      return
    }

    if (this.tool === 'pen') {
      event.preventDefault()
      this.beginGesture()
      const pressure = this.pressureFromEvent(event)
      const point: StrokePoint = { ...this.pointerWorld, ...(pressure !== undefined ? { pressure } : {}) }
      const id = this.board.beginStroke(
        this.penColor,
        this.strokeWidthForStyle(),
        point,
        this.penStyle,
        this.pressureSensitivity,
      )
      this.drag = { kind: 'draw', id, last: this.pointerWorld }
      UI.dom.canvas.setPointerCapture(event.pointerId)
      this.requestRender()
      return
    }

    if (this.tool === 'connect') {
      event.preventDefault()
      const note = this.noteAtScreen(screen)
      const anchor: Anchor = note ? { noteId: note.id } : { ...this.pointerWorld }
      const aPoint = note ? { x: note.x + note.w / 2, y: note.y + note.h / 2 } : { ...this.pointerWorld }
      this.drag = {
        kind: 'connect',
        a: anchor,
        aPoint,
        b: this.pointerWorld,
        targetId: null,
        valid: false,
        moved: false,
      }
      UI.dom.canvas.setPointerCapture(event.pointerId)
      this.requestRender()
      return
    }

    // select tool
    const pinId = this.renderer.pinAt(screen)
    if (pinId) {
      event.preventDefault()
      this.handlePinClick(pinId)
      return
    }

    const selectedBox = this.singleSelectedBox()
    if (selectedBox && !selectedBox.pinned) {
      const handle = this.renderer.handleAt(screen, selectedBox)
      if (handle) {
        event.preventDefault()
        this.beginGesture()
        this.drag = {
          kind: 'resize',
          id: selectedBox.id,
          handle,
          orig: {
            x: selectedBox.x,
            y: selectedBox.y,
            w: selectedBox.w,
            h: selectedBox.h,
          },
          start: this.pointerWorld,
          ratio: selectedBox.w / Math.max(1, selectedBox.h),
        }
        UI.dom.canvas.setPointerCapture(event.pointerId)
        this.setCanvasCursor()
        return
      }
    }

    const item = this.itemAtScreen(screen)
    if (item) {
      event.preventDefault()
      const additive = event.shiftKey
      if (additive) {
        this.toggleSelection([item.id], true)
        if (!this.selection.has(item.id)) {
          this.requestRender()
          return
        }
      } else if (!this.selection.has(item.id)) {
        this.setSelection([item.id])
      } else if (item.groupId) {
        const expanded = this.board.expandGroups([item.id])
        if (expanded.some((id) => !this.selection.has(id))) this.setSelection([item.id])
      }
      if (item.type === 'connector') {
        this.requestRender()
        return
      }
      if (item.pinned) {
        this.toast(t('toast.lockedMove'))
        this.requestRender()
        return
      }
      const selectedNow = this.selectedItems()
      const pinnedSelected = selectedNow.some((i) => i.pinned)
      const movable = selectedNow
        .filter((i) => i.type !== 'connector' && !i.pinned)
        .map((i) => i.id)
      if (!movable.length) {
        this.toast(t('toast.lockedMove'))
        return
      }
      this.beginGesture()
      this.drag = {
        kind: 'move',
        ids: movable,
        last: { ...this.pointerWorld },
        mixedPinned: pinnedSelected,
        warned: false,
        moved: false,
      }
      UI.dom.canvas.setPointerCapture(event.pointerId)
      this.requestRender()
      return
    }

    // empty canvas -> marquee
    event.preventDefault()
    UI.hideSelectionBar()
    const additive = event.shiftKey
    const base = additive ? new Set(this.selection) : new Set<string>()
    if (!additive) this.setSelection([])
    this.drag = {
      kind: 'marquee',
      start: screen,
      current: screen,
      base,
    }
    UI.dom.canvas.setPointerCapture(event.pointerId)
    this.startLongPress(event.pointerId, screen)
    this.requestRender()
  }

  private onPointerMove(event: PointerEvent): void {
    const screen = pointFromEvent(event, UI.dom.canvas)
    this.pointerScreen = screen
    this.pointerWorld = screenToWorld(this.camera, screen.x, screen.y)
    this.pointerOnCanvas = true
    this.presence.updateCursor(this.pointerWorld)

    if (!this.drag) {
      if (this.tool === 'laser') {
        this.updateLaser(this.pointerWorld)
        this.updateHover(screen)
        return
      }
      if (this.tool === 'pen' || this.tool === 'eraser') {
        this.hoveredId = null
        this.hoveredPinId = null
        this.requestRender()
        return
      }
      this.updateHover(screen)
      return
    }

    if (this.drag.kind === 'pan') {
      const dx = (screen.x - this.drag.start.x) / this.camera.scale
      const dy = (screen.y - this.drag.start.y) / this.camera.scale
      this.applyCamera({ ...this.camera, x: this.drag.cam.x - dx, y: this.drag.cam.y - dy }, true)
      return
    }

    if (this.drag.kind === 'marquee') {
      if (
        this.longPressTimer &&
        this.longPressScreen &&
        Math.hypot(screen.x - this.longPressScreen.x, screen.y - this.longPressScreen.y) > 4
      ) {
        this.cancelLongPress()
      }
      this.drag.current = screen
      const rect = this.currentMarquee()
      if (rect) {
        const widthWorld = rect.w / this.camera.scale
        const heightWorld = rect.h / this.camera.scale
        if (widthWorld > 2 || heightWorld > 2) {
          const worldRect: Rect = {
            x: rect.x / this.camera.scale + this.camera.x,
            y: rect.y / this.camera.scale + this.camera.y,
            w: widthWorld,
            h: heightWorld,
          }
          const matched = this.board
            .visibleItems()
            .filter((item) => rectsIntersect(itemBounds(item, this.board.visibleNotes()), worldRect))
            .map((item) => item.id)
          const next = new Set([...this.drag.base, ...matched])
          this.setSelection([...next], false)
        }
      }
      this.requestRender()
      return
    }

    if (this.drag.kind === 'lasso') {
      const last = this.drag.points[this.drag.points.length - 1]
      if (!last || Math.hypot(screen.x - last.x, screen.y - last.y) >= 2.5) {
        this.drag.points.push(screen)
        if (this.drag.points.length > 900) this.drag.points.splice(1, 1)
        this.updateLassoSelection()
      }
      this.requestRender()
      return
    }

    if (this.drag.kind === 'move') {
      const dx = this.pointerWorld.x - this.drag.last.x
      const dy = this.pointerWorld.y - this.drag.last.y
      if (dx || dy) {
        this.drag.last = { ...this.pointerWorld }
        const blocked = this.board.moveItems(this.drag.ids, dx, dy)
        this.drag.moved = true
        if ((blocked.length || this.drag.mixedPinned) && !this.drag.warned) {
          this.drag.warned = true
          this.toast(t('toast.mixedMove'))
        }
        this.requestRender()
      }
      return
    }

    if (this.drag.kind === 'resize') {
      this.applyResize(event)
      return
    }

    if (this.drag.kind === 'draw') {
      const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
      const samples = coalesced.length ? coalesced : [event]
      const points: StrokePoint[] = []
      let last = this.drag.last
      for (const sample of samples) {
        const local = pointFromEvent(sample, UI.dom.canvas)
        const world = screenToWorld(this.camera, local.x, local.y)
        if (Math.hypot(world.x - last.x, world.y - last.y) <= 0.65 / this.camera.scale) continue
        const pressure = this.pressureFromEvent(sample)
        points.push({ ...world, ...(pressure !== undefined ? { pressure } : {}) })
        last = world
      }
      if (points.length) {
        this.drag.last = last
        this.board.appendStrokePoints(this.drag.id, points)
        this.requestRender()
      }
      return
    }

    if (this.drag.kind === 'erase') {
      if (Math.hypot(this.pointerWorld.x - this.drag.last.x, this.pointerWorld.y - this.drag.last.y) > 0.5 / this.camera.scale) {
        this.eraseStrokesAlong(this.drag.last, this.pointerWorld)
        this.drag.last = { ...this.pointerWorld }
        this.requestRender()
      }
      return
    }

    if (this.drag.kind === 'connect') {
      this.drag.b = { ...this.pointerWorld }
      this.drag.moved = true
      const target = this.noteAtScreen(screen)
      this.drag.targetId = target?.id ?? null
      const same = target && 'noteId' in this.drag.a && target.id === this.drag.a.noteId
      const freeDistance = Math.hypot(
        this.drag.b.x - this.drag.aPoint.x,
        this.drag.b.y - this.drag.aPoint.y,
      )
      this.drag.valid = !same && (target ? true : freeDistance > 12 / this.camera.scale)
      this.requestRender()
    }
  }

  private updateLassoSelection(): void {
    if (this.drag?.kind !== 'lasso') return
    const polygon = this.drag.points.map((p) => screenToWorld(this.camera, p.x, p.y))
    const matched =
      polygon.length >= 3
        ? this.board
            .visibleItems()
            .filter((item) => {
              const bounds = itemBounds(item, this.board.visibleNotes())
              return pointInPolygon({ x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }, polygon)
            })
            .map((item) => item.id)
        : []
    this.setSelection([...this.drag.base, ...matched], false)
  }

  private updateHover(screen: Point): void {
    const pinId = this.renderer.pinAt(screen)
    let hovered: string | null = null
    let handle: HandleName | null = null
    if (pinId) {
      hovered = pinId
    } else {
      hovered = this.itemAtScreen(screen)?.id ?? null
      const box = this.singleSelectedBox()
      if (box && !box.pinned) handle = this.renderer.handleAt(screen, box)
    }
    const changed = hovered !== this.hoveredId || pinId !== this.hoveredPinId
    this.hoveredId = hovered
    this.hoveredPinId = pinId
    if (this.tool === 'select') {
      if (pinId) UI.dom.canvas.style.cursor = 'pointer'
      else if (handle) UI.dom.canvas.style.cursor = resizeCursor(handle)
      else UI.dom.canvas.style.cursor = 'default'
    }
    if (changed) this.requestRender()
  }

  private applyResize(event: PointerEvent): void {
    if (this.drag?.kind !== 'resize') return
    const item = this.board.item(this.drag.id)
    if (!item || (item.type !== 'note' && item.type !== 'text' && item.type !== 'image')) return
    const orig = this.drag.orig
    const minW = item.type === 'note' ? 70 : item.type === 'text' ? 40 : 40
    const minH = item.type === 'note' ? 70 : item.type === 'text' ? 28 : 40
    let x = orig.x
    let y = orig.y
    let w = orig.w
    let h = orig.h
    const handle = this.drag.handle
    if (handle.includes('e')) w = Math.max(minW, this.pointerWorld.x - orig.x)
    if (handle.includes('s')) h = Math.max(minH, this.pointerWorld.y - orig.y)
    if (handle.includes('w')) {
      const right = orig.x + orig.w
      x = Math.min(this.pointerWorld.x, right - minW)
      w = right - x
    }
    if (handle.includes('n')) {
      const bottom = orig.y + orig.h
      y = Math.min(this.pointerWorld.y, bottom - minH)
      h = bottom - y
    }
    if (item.type === 'image' && handle.length === 2 && !event.shiftKey) {
      const ratio = this.drag.ratio
      const newW = Math.max(minW, w)
      const newH = Math.max(minH, newW / ratio)
      if (handle.includes('w')) x = orig.x + orig.w - newW
      else x = orig.x
      if (handle.includes('n')) y = orig.y + orig.h - newH
      else y = orig.y
      w = newW
      h = newH
    }
    if (!this.board.setBoxRect(item.id, { x, y, w, h })) {
      this.drag = null
      this.endGesture()
      this.toast(t('toast.lockedResize'))
      return
    }
    this.requestRender()
  }

  private onPointerUp(event: PointerEvent): void {
    this.cancelLongPress()
    const screen = pointFromEvent(event, UI.dom.canvas)
    this.pointerScreen = screen
    this.pointerWorld = screenToWorld(this.camera, screen.x, screen.y)
    const drag = this.drag
    if (!drag) {
      this.requestRender()
      return
    }
    if (drag.kind === 'pan' || drag.kind === 'marquee') {
      if (drag.kind === 'marquee') {
        this.presence.setSelection([...this.selection])
        if (!drag.base.size && this.selection.size === 0) {
          // a plain click on empty space
        }
        this.requestRender()
      }
    } else if (drag.kind === 'lasso') {
      this.updateLassoSelection()
      this.presence.setSelection([...this.selection])
      this.requestRender()
    } else if (drag.kind === 'move') {
      this.endGesture()
    } else if (drag.kind === 'resize') {
      this.endGesture()
    } else if (drag.kind === 'draw' || drag.kind === 'erase') {
      this.endGesture()
    } else if (drag.kind === 'connect') {
      const target = this.noteAtScreen(screen)
      const b: Anchor = target ? { noteId: target.id } : { ...this.pointerWorld }
      const same = target && 'noteId' in drag.a && target.id === drag.a.noteId
      const freeDistance = Math.hypot(
        this.pointerWorld.x - drag.aPoint.x,
        this.pointerWorld.y - drag.aPoint.y,
      )
      const valid = drag.moved && !same && (target ? true : freeDistance > 12 / this.camera.scale)
      if (valid) {
        this.beginGesture()
        const id = this.board.createConnector(drag.a, b)
        this.endGesture()
        if (id) {
          this.setSelection([id])
          this.setTool('select')
        }
      } else if (drag.moved) {
        this.toast(t('toast.connectorTooShort'))
      }
    }
    this.drag = null
    if (UI.dom.canvas.hasPointerCapture(event.pointerId)) {
      UI.dom.canvas.releasePointerCapture(event.pointerId)
    }
    this.setCanvasCursor()
    this.requestRender()
  }

  private onDoubleClick(event: MouseEvent): void {
    if (UI.isNameModalVisible() || UI.isGuideOpen() || UI.isSettingsOpen()) return
    if (!this.doubleClickEditsNote) return
    const screen = pointFromEvent(event, UI.dom.canvas)
    const world = screenToWorld(this.camera, screen.x, screen.y)
    const note = [...this.board.visibleNotes().values()]
      .sort((a, b) => b.z - a.z)
      .find((n) => pointInRect(world, { x: n.x, y: n.y, w: n.w, h: n.h }))
    if (note) {
      this.setSelection([note.id])
      this.setTool('select')
      this.openNoteEditor(note.id)
      return
    }
    const textItem = [...this.board.visibleItems()]
      .filter((item): item is TextItem => item.type === 'text')
      .sort((a, b) => b.z - a.z)
      .find((item) => pointInRect(world, { x: item.x, y: item.y, w: item.w, h: item.h }))
    if (textItem) {
      this.setSelection([textItem.id])
      this.setTool('select')
      this.openTextEditor(textItem.id)
      return
    }
    this.beginGesture()
    const id = this.board.createNote(
      { x: world.x - 90, y: world.y - 90, w: 180, h: 180 },
      this.noteColor,
    )
    this.endGesture()
    this.setSelection([id])
    this.setTool('select')
    this.openNoteEditor(id)
  }

  /* ------------------------------------------------------------------ */
  /* laser, reactions, follow                                           */
  /* ------------------------------------------------------------------ */

  private updateLaser(world: Point): void {
    this.localLaser.push({ x: world.x, y: world.y, t: performance.now() })
    if (this.localLaser.length > 40) this.localLaser.shift()
    this.presence.sendLaser(world)
    this.requestRender()
  }

  private selectReaction(kind: string): void {
    const fallback = screenToWorld(this.camera, this.renderer.W / 2, this.renderer.H / 2)
    const anchor = this.reactionAnchor ?? fallback
    let burst = this.reactionBurst
    if (!burst || burst.kind !== kind) {
      burst = { id: uuid(), kind, count: 0, x: anchor.x, y: anchor.y }
      this.reactionBurst = burst
      this.reactionLimitNotified = false
    }
    if (burst.count >= 99) {
      if (!this.reactionLimitNotified) {
        this.reactionLimitNotified = true
        this.toast(t('toast.reactionLimit'))
      }
      return
    }
    burst.count += 1
    const count = burst.count
    const now = performance.now()
    const existing = this.reactions.find((item) => item.id === burst!.id)
    if (existing) {
      existing.kind = kind
      existing.x = burst.x
      existing.y = burst.y
      existing.count = count
      existing.updatedAt = now
    } else {
      this.reactions.push({
        id: burst.id,
        kind,
        x: burst.x,
        y: burst.y,
        count,
        start: now,
        updatedAt: now,
        color: this.presence.color,
      })
    }
    this.presence.publishReaction({
      id: burst.id,
      kind,
      x: burst.x,
      y: burst.y,
      count,
      ts: Date.now(),
    })
    UI.setReactionPaletteCount(kind, count)
    if (count === 99) {
      this.reactionLimitNotified = true
      this.toast(t('toast.reactionLimit'))
    }
    this.requestRender()
  }

  private openReactionPaletteAt(screenPoint: Point, palettePoint: Point): void {
    UI.hideContextMenu()
    UI.hideMenu()
    this.reactionAnchor = screenToWorld(this.camera, screenPoint.x, screenPoint.y)
    this.reactionBurst = null
    this.reactionLimitNotified = false
    UI.showReactionPalette(palettePoint.x, palettePoint.y)
    this.requestRender()
  }

  private openReactionPaletteAtPointer(): void {
    if (UI.isReactionPaletteOpen()) {
      this.closeReactionPalette()
      return
    }
    const rect = UI.dom.canvas.getBoundingClientRect()
    const screen = this.pointerOnCanvas
      ? this.pointerScreen
      : { x: this.renderer.W / 2, y: this.renderer.H / 2 }
    this.openReactionPaletteAt(
      screen,
      { x: rect.left + screen.x, y: rect.top + screen.y },
    )
  }

  private openReactionPaletteFromButton(): void {
    const rect = UI.dom.btnReactions.getBoundingClientRect()
    this.openReactionPaletteAt(
      { x: this.renderer.W / 2, y: this.renderer.H / 2 },
      { x: rect.left + rect.width / 2, y: rect.bottom + 6 },
    )
  }

  private closeReactionPalette(): void {
    UI.hideReactionPalette()
    this.reactionAnchor = null
    this.reactionBurst = null
    this.reactionLimitNotified = false
    this.requestRender()
  }

  private toggleGuide(): void {
    const open = !UI.isGuideOpen()
    if (open) {
      this.closeReactionPalette()
      UI.hideMenu()
      UI.hideContextMenu()
    }
    UI.setGuideVisible(open)
    this.requestRender()
  }

  private openSettings(): void {
    this.closeReactionPalette()
    UI.hideMenu()
    UI.hideContextMenu()
    UI.setGuideVisible(false)
    UI.syncSettings({
      doubleClickEdit: this.doubleClickEditsNote,
      minimapVisible: this.minimapVisible,
    })
    UI.setSettingsVisible(true)
    this.requestRender()
  }

  private setDoubleClickEdit(value: boolean): void {
    this.doubleClickEditsNote = value
    try {
      localStorage.setItem('pinboard-dbl-edit', value ? '1' : '0')
    } catch {
      // ignore storage errors
    }
  }

  private openNoteEditor(id: string): void {
    if (this.textEditor.isOpen()) this.textEditor.close(true)
    this.editor.open(id)
  }

  private openTextEditor(id: string): void {
    if (this.editor.isOpen()) this.editor.close(true)
    this.textEditor.open(id)
  }

  private closeEditors(commit = true): void {
    this.editor.close(commit)
    this.textEditor.close(commit)
  }

  private editSelection(): void {
    const items = this.selectedItems()
    if (items.length !== 1) return
    const item = items[0]
    if (item.type === 'note') {
      this.setTool('select')
      this.openNoteEditor(item.id)
    } else if (item.type === 'text') {
      this.setTool('select')
      this.openTextEditor(item.id)
    }
  }

  private initMinimapVisibility(): void {
    let stored: string | null = null
    try {
      stored = localStorage.getItem('pinboard-minimap')
    } catch {
      // storage may be unavailable
    }
    const visible = stored === '0' ? false : stored === '1' ? true : window.innerWidth >= 900
    this.setMinimapVisible(visible, false)
  }

  private setMinimapVisible(visible: boolean, persist = true): void {
    this.minimapVisible = visible
    UI.dom.viewport.classList.toggle('minimap-hidden', !visible)
    if (persist) {
      try {
        localStorage.setItem('pinboard-minimap', visible ? '1' : '0')
      } catch {
        // ignore storage errors
      }
    }
    if (visible) {
      requestAnimationFrame(() => {
        this.renderer.resize()
        this.requestRender()
      })
    } else {
      this.requestRender()
    }
  }

  /* ------------------------------------------------------------------ */
  /* delete / duplicate / clipboard                                      */
  /* ------------------------------------------------------------------ */

  private deleteSelection(): void {
    if (!this.selection.size) return
    const result = this.board.deleteItems([...this.selection])
    if (!result.deleted.length) {
      this.toast(t('toast.lockedDelete'))
      return
    }
    const deleted = new Set(result.deleted)
    this.setSelection([...this.selection].filter((id) => !deleted.has(id)))
    if (result.blocked.length) {
      this.toast(t('toast.deletedPartial', { n: result.deleted.length, kept: result.blocked.length }))
    } else {
      this.toast(t('toast.deleted'))
    }
    this.requestRender()
  }

  private duplicateSelection(): void {
    const ids = this.board.duplicateItems([...this.selection])
    if (!ids.length) {
      this.toast(t('toast.duplicateNone'))
      return
    }
    this.setSelection(ids)
    this.setTool('select')
    this.toast(t('toast.duplicated'))
  }

  private copySelection(): void {
    const items = this.selectedItems().filter((item) => item.type !== 'connector')
    if (!items.length) {
      this.toast(t('toast.copyNone'))
      return
    }
    this.clipboard = structuredClone(items)
    this.pasteCount = 0
    this.toast(t('toast.copied', { n: items.length }))
  }

  private pasteClipboard(): boolean {
    if (!this.clipboard.length) return false
    this.pasteCount += 1
    const offset = 24 * this.pasteCount
    const clones = structuredClone(this.clipboard).map((item) => {
      if (item.type === 'note' || item.type === 'text' || item.type === 'image' || item.type === 'stroke') {
        item.x += offset
        item.y += offset
      }
      item.pinned = false
      item.pinnedAt = null
      item.deleted = false
      return item
    })
    this.board.stopCapturing()
    const { ids } = this.board.importItems(clones)
    this.board.stopCapturing()
    this.setSelection(ids)
    this.setTool('select')
    this.toast(t('toast.pasted'))
    return true
  }

  private doUndo(): void {
    if (!this.board.undo()) {
      this.toast(t('toast.undoNone'))
      return
    }
    this.editor.refresh()
    this.textEditor.refresh()
    this.requestRender()
  }

  private doRedo(): void {
    if (!this.board.redo()) {
      this.toast(t('toast.redoNone'))
      return
    }
    this.editor.refresh()
    this.textEditor.refresh()
    this.requestRender()
  }

  /* ------------------------------------------------------------------ */
  /* keyboard                                                            */
  /* ------------------------------------------------------------------ */

  private bindKeyboard(): void {
    window.addEventListener('keydown', (event) => this.onKeyDown(event))
    window.addEventListener('keyup', (event) => this.onKeyUp(event))
    window.addEventListener('blur', () => {
      this.spaceDown = false
      this.presence.updateCursor(null, true)
      this.presence.sendLaser(null)
    })
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (UI.isNameModalVisible()) {
      if (event.key === 'Escape') {
        event.preventDefault()
        this.cancelNamePrompt()
      }
      return
    }
    if (UI.isSettingsOpen()) {
      if (event.key === 'Escape') {
        event.preventDefault()
        UI.setSettingsVisible(false)
        this.requestRender()
      }
      return
    }
    if (UI.isGuideOpen()) {
      if (event.key === 'Escape' || event.key === '?') {
        event.preventDefault()
        UI.setGuideVisible(false)
        this.requestRender()
      }
      return
    }
    const editable = isEditableTarget(event.target)
    if (editable) return

    const mod = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()

    if (mod) {
      if (key === 'z') {
        event.preventDefault()
        if (event.shiftKey) this.doRedo()
        else this.doUndo()
        return
      }
      if (key === 'y') {
        event.preventDefault()
        this.doRedo()
        return
      }
      if (key === 'd') {
        event.preventDefault()
        this.duplicateSelection()
        return
      }
      if (key === 'g') {
        event.preventDefault()
        if (event.shiftKey) this.ungroupSelection()
        else this.toggleGroupSelection()
        return
      }
      if (key === 'c') {
        this.copySelection()
        return
      }
      if (key === 'v') {
        if (this.pasteClipboard()) event.preventDefault()
        return
      }
      if (key === '0') {
        event.preventDefault()
        this.fitAll(true)
        return
      }
      if (key === '=' || key === '+') {
        event.preventDefault()
        this.zoomAtCenter(1.2)
        return
      }
      if (key === '-') {
        event.preventDefault()
        this.zoomAtCenter(1 / 1.2)
        return
      }
      return
    }

    if (event.key === '?') {
      event.preventDefault()
      this.toggleGuide()
      return
    }

    if (event.code === 'Space') {
      this.spaceDown = true
      this.setCanvasCursor()
      event.preventDefault()
      return
    }

    if (event.key === 'Escape') {
      this.handleEscape()
      return
    }

    if (UI.isReactionPaletteOpen() && /^[1-6]$/.test(event.key)) {
      const kind = REACTIONS[Number(event.key) - 1]
      if (kind) this.selectReaction(kind)
      event.preventDefault()
      return
    }

    if (
      (event.key === 'Enter' || event.key === 'F2') &&
      !event.shiftKey &&
      !event.altKey &&
      !UI.isReactionPaletteOpen() &&
      !(document.activeElement instanceof HTMLButtonElement)
    ) {
      const items = this.selectedItems()
      if (items.length === 1 && (items[0].type === 'note' || items[0].type === 'text')) {
        event.preventDefault()
        this.editSelection()
        return
      }
    }

    if (key === 'l' && !event.repeat && !this.drag) {
      if (this.tool !== 'laser') {
        this.tempLaserPrevious = this.tool
        this.setTool('laser')
      }
      event.preventDefault()
      return
    }

    if (key === 'i') {
      event.preventDefault()
      this.openImagePicker()
      return
    }

    if (key === 'm' && !event.repeat) {
      event.preventDefault()
      this.setMinimapVisible(!this.minimapVisible)
      return
    }

    if (event.shiftKey && key === 'p') {
      event.preventDefault()
      this.togglePinOnSelection()
      return
    }

    if (key === 'v') this.setTool('select')
    else if (key === 's') this.setTool('lasso')
    else if (key === 'n') this.setTool('note')
    else if (key === 't') this.setTool('text')
    else if (key === 'p') this.setTool('pen')
    else if (key === 'r') this.setTool('eraser')
    else if (key === 'c') this.setTool('connect')
    else if (key === 'g') {
      this.togglePinPanel()
      event.preventDefault()
    } else if (key === 'e') {
      this.openReactionPaletteAtPointer()
      event.preventDefault()
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      if (this.selection.size) {
        event.preventDefault()
        this.deleteSelection()
      }
    } else if (event.key === '=' || event.key === '+') {
      this.zoomAtCenter(1.2)
    } else if (event.key === '-') {
      this.zoomAtCenter(1 / 1.2)
    }
  }

  private handleEscape(): void {
    this.cancelLongPress()
    if (UI.isSettingsOpen()) {
      UI.setSettingsVisible(false)
      this.requestRender()
      return
    }
    if (UI.isGuideOpen()) {
      UI.setGuideVisible(false)
      this.requestRender()
      return
    }
    if (this.editingId) {
      this.closeEditors(true)
      return
    }
    if (this.followId) {
      this.stopFollow(true)
      return
    }
    if (UI.isReactionPaletteOpen()) {
      this.closeReactionPalette()
      return
    }
    if (UI.isContextMenuOpen() || !UI.dom.menu.hidden) {
      UI.hideContextMenu()
      UI.hideMenu()
      return
    }
    if (UI.isPinnedPanelOpen()) {
      this.togglePinPanel(false)
      return
    }
    if (this.tool === 'laser') {
      const prev = this.tempLaserPrevious
      this.tempLaserPrevious = null
      this.setTool(prev && prev !== 'laser' ? prev : 'select')
      this.presence.sendLaser(null)
      return
    }
    if (this.tool !== 'select') {
      this.setTool('select')
      return
    }
    if (this.selection.size) {
      this.clearSelection()
    }
  }

  private onKeyUp(event: KeyboardEvent): void {
    if (UI.isNameModalVisible()) return
    if (event.code === 'Space') {
      this.spaceDown = false
      this.setCanvasCursor()
    }
    if (event.key.toLowerCase() === 'l' && this.tempLaserPrevious !== null) {
      const previous = this.tempLaserPrevious
      this.tempLaserPrevious = null
      this.setTool(previous)
      this.presence.sendLaser(null)
    }
  }

  /* ------------------------------------------------------------------ */
  /* minimap                                                             */
  /* ------------------------------------------------------------------ */

  private bindMinimap(): void {
    const mm = UI.dom.minimap
    let dragging = false
    let moved = false
    let startClient = { x: 0, y: 0 }
    let startCenter = { cx: 0, cy: 0 }
    let mapScale = 0

    const animateToWorld = (world: Point): void => {
      this.cameraAnimation = null
      if (this.followId) this.stopFollow(false)
      if (UI.isReactionPaletteOpen()) this.closeReactionPalette()
      this.userTouchedCamera = true
      const scale = this.camera.scale
      this.cameraAnimation = {
        from: { ...this.camera },
        to: {
          x: world.x - this.renderer.W / (2 * scale),
          y: world.y - this.renderer.H / (2 * scale),
          scale,
        },
        start: performance.now(),
        duration: 240,
      }
      this.requestRender()
    }

    mm.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      dragging = true
      moved = false
      startClient = { x: event.clientX, y: event.clientY }
      startCenter = {
        cx: this.camera.x + this.renderer.W / (2 * this.camera.scale),
        cy: this.camera.y + this.renderer.H / (2 * this.camera.scale),
      }
      mapScale = this.renderer.minimapScale()
      mm.setPointerCapture(event.pointerId)
    })
    mm.addEventListener('pointermove', (event) => {
      if (!dragging || !mapScale) return
      const dx = event.clientX - startClient.x
      const dy = event.clientY - startClient.y
      if (!moved && Math.hypot(dx, dy) < 3) return
      moved = true
      const scale = this.camera.scale
      const cx = startCenter.cx + (dx / mapScale) * this.minimapSensitivity
      const cy = startCenter.cy + (dy / mapScale) * this.minimapSensitivity
      this.applyCamera(
        {
          x: cx - this.renderer.W / (2 * scale),
          y: cy - this.renderer.H / (2 * scale),
          scale,
        },
        true,
      )
    })
    const finish = (event: PointerEvent): void => {
      if (!dragging) return
      dragging = false
      if (mm.hasPointerCapture(event.pointerId)) mm.releasePointerCapture(event.pointerId)
      if (!moved) {
        const world = this.renderer.minimapWorldAt(event.clientX, event.clientY)
        if (world) animateToWorld(world)
      }
    }
    mm.addEventListener('pointerup', finish)
    mm.addEventListener('pointercancel', finish)
  }

  /* ------------------------------------------------------------------ */
  /* images / import / export                                            */
  /* ------------------------------------------------------------------ */

  private openImagePicker(): void {
    UI.dom.fileInput.value = ''
    UI.dom.fileInput.click()
  }

  private async addImages(files: File[], screenPoint?: Point): Promise<void> {
    const valid = files.filter(isProbablyImageFile)
    if (!valid.length) {
      this.toast(t('toast.imageUnsupported'))
      return
    }
    this.toast(valid.length > 1 ? t('toast.imageAddingMany', { n: valid.length }) : t('toast.imageAddingOne'))
    const base = screenPoint
      ? screenToWorld(this.camera, screenPoint.x, screenPoint.y)
      : {
          x: this.camera.x + this.renderer.W / (2 * this.camera.scale),
          y: this.camera.y + this.renderer.H / (2 * this.camera.scale),
        }
    const ids: string[] = []
    let failed = 0
    let lastError: unknown = null
    for (let index = 0; index < valid.length; index++) {
      const file = valid[index]
      try {
        const result = await this.assets.importFile(file)
        const maxW = 420
        const maxH = 320
        const scale = Math.min(1, maxW / result.naturalW, maxH / result.naturalH)
        const w = Math.max(60, Math.round(result.naturalW * scale))
        const h = Math.max(60, Math.round(result.naturalH * scale))
        const offset = index * 26
        const id = this.board.createImage({
          x: base.x - w / 2 + offset,
          y: base.y - h / 2 + offset,
          w,
          h,
          assetId: result.assetId,
          naturalW: result.naturalW,
          naturalH: result.naturalH,
        })
        ids.push(id)
      } catch (error) {
        failed++
        lastError = error
        console.warn('[image] add failed', error)
      }
    }
    if (ids.length) {
      this.setSelection(ids)
      this.setTool('select')
      this.board.stopCapturing()
      this.toast(failed ? t('toast.imagesPartial', { n: ids.length, failed }) : t('toast.imageAdded'))
      this.requestRender()
    } else {
      this.toast(lastError instanceof Error ? lastError.message : t('toast.imageFailed'))
    }
  }

  private bindDropAndPaste(): void {
    const viewport = UI.dom.viewport
    viewport.addEventListener('dragenter', (event) => {
      if (![...event.dataTransfer?.types ?? []].includes('Files')) return
      event.preventDefault()
      this.dropDepth++
      UI.setDropOverlay(true)
    })
    viewport.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes('Files')) {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }
    })
    viewport.addEventListener('dragleave', () => {
      this.dropDepth = Math.max(0, this.dropDepth - 1)
      if (!this.dropDepth) UI.setDropOverlay(false)
    })
    viewport.addEventListener('drop', (event) => {
      event.preventDefault()
      this.dropDepth = 0
      UI.setDropOverlay(false)
      const files = event.dataTransfer?.files ? [...event.dataTransfer.files] : []
      if (!files.length) return
      const screen = pointFromEvent(event, UI.dom.canvas)
      void this.addImages(files, screen)
    })

    window.addEventListener('paste', (event) => {
      if (isEditableTarget(event.target) || UI.isNameModalVisible()) return
      const files = event.clipboardData?.files ? [...event.clipboardData.files] : []
      const images = files.filter(isProbablyImageFile)
      if (images.length) {
        event.preventDefault()
        void this.addImages(images)
      }
    })
  }

  private async exportPngFile(): Promise<void> {
    this.toast(t('toast.exportPngStart'))
    try {
      const ok = await exportPng(this.board, this.assets)
      this.toast(ok ? t('toast.exportPngDone') : t('toast.exportEmpty'))
    } catch (error) {
      console.error(error)
      this.toast(t('toast.exportPngFail'))
    }
  }

  private async exportJsonFile(): Promise<void> {
    this.toast(t('toast.exportJsonStart'))
    try {
      await exportJson(this.board, this.assets)
      this.toast(t('toast.exportJsonDone'))
    } catch (error) {
      console.error(error)
      this.toast(t('toast.exportJsonFail'))
    }
  }

  private async importJsonFile(file: File): Promise<void> {
    const peers = this.presence.peerList.length
    if (peers > 0) {
      const ok = window.confirm(t('confirm.import'))
      if (!ok) return
    }
    this.toast(t('toast.importStart'))
    try {
      const result = await importJson(file, this.board, this.assets)
      this.board.stopCapturing()
      this.requestRender()
      this.toast(
        result.skipped
          ? t('toast.importPartial', { n: result.count, skipped: result.skipped })
          : t('toast.importDone', { n: result.count }),
      )
    } catch (error) {
      console.error(error)
      this.toast(error instanceof Error ? error.message : t('toast.importFail'))
    }
  }

  private createNewRoom(): void {
    if (!window.confirm(t('confirm.newRoom'))) return
    location.assign(`/r/${randomRoomId()}`)
  }

  private copyShareLink(): void {
    if (!this.hasCustomName) {
      this.openShareNamePrompt()
      return
    }
    void this.performCopyShareLink()
  }

  private async performCopyShareLink(): Promise<void> {
    try {
      await copyText(location.href)
      this.toast(t('toast.linkCopied'))
    } catch {
      this.toast(t('toast.linkCopyFail'))
    }
  }

  /* ------------------------------------------------------------------ */
  /* title / utility                                                     */
  /* ------------------------------------------------------------------ */

  private syncTitleFromBoard(): void {
    const title = this.board.title()
    if (document.activeElement !== UI.dom.roomTitle) {
      UI.setRoomTitle(title)
    }
    this.updatePageTitle(title)
  }

  private updatePageTitle(title = this.board.title()): void {
    document.title = title ? `${title} · ${t('app.pageSuffix')}` : t('app.fullName')
  }

  private toast(message: string): void {
    UI.toast(message)
  }

  private bindResize(): void {
    window.addEventListener('resize', () => {
      const center = {
        cx: this.camera.x + this.renderer.W / (2 * this.camera.scale),
        cy: this.camera.y + this.renderer.H / (2 * this.camera.scale),
      }
      this.renderer.resize()
      this.camera = {
        ...this.camera,
        x: center.cx - this.renderer.W / (2 * this.camera.scale),
        y: center.cy - this.renderer.H / (2 * this.camera.scale),
      }
      this.presence.updateView(this.viewOfCamera())
      this.editor.reposition()
      this.textEditor.reposition()
      this.requestRender()
    })
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.presence.updateCursor(null, true)
        this.presence.sendLaser(null)
      }
    })
  }

  private bindNetworkEvents(): void {
    window.addEventListener('offline', () => {
      this.connection = 'disconnected'
      this.refreshConnection()
      this.presence.updateCursor(null, true)
      this.presence.sendLaser(null)
      this.presence.provider.disconnect()
    })
    window.addEventListener('online', () => {
      this.connection = 'connecting'
      this.refreshConnection()
      this.presence.provider.connect()
    })
  }
}
