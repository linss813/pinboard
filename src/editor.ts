import * as Y from 'yjs'
import type { Board } from './board'
import type { NoteAlign, NoteItem, NoteLine, NoteListStyle, NoteTextSize } from '../shared/types'
import { NOTE_DEFAULT_SIZE, NOTE_TEXT_SIZE_PX, readableTextColor } from '../shared/constants'
import type { Camera } from '../shared/geometry'
import { worldToScreen } from '../shared/geometry'
import { t } from './i18n'
import { uuid } from './util'

export interface EditorHost {
  board: Board
  element: HTMLElement
  formatBar: HTMLElement
  getCamera(): Camera
  getItem(id: string): NoteItem | null
  onOpen(id: string): void
  onClose(id: string): void
  requestRender(): void
  undo(): void
  redo(): void
  toast(message: string): void
}

interface CaretPoint {
  lineId: string
  offset: number
}

interface SelectionSnapshot {
  anchor: CaretPoint
  focus: CaretPoint
}

type FormatAction =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'bullet'
  | 'ordered'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'clear'

export class NoteEditor {
  private id: string | null = null
  private ylines: Y.Array<Y.Map<any>> | null = null
  private observer: (() => void) | null = null
  private lines: NoteLine[] = []
  private composing = false
  private suppressing = false
  private remoteDuringComposition = false
  private rendering = false
  private activeLineIds: string[] = []
  private lastSelection: SelectionSnapshot | null = null
  private blurTimer: ReturnType<typeof setTimeout> | null = null
  private readonly sizeSelect: HTMLSelectElement

  constructor(private readonly host: EditorHost) {
    const el = host.element
    const bar = host.formatBar
    const select = bar.querySelector<HTMLSelectElement>('#fmtSize')
    if (!select) throw new Error('Missing format size selector')
    this.sizeSelect = select

    el.addEventListener('blur', () => {
      if (this.blurTimer) clearTimeout(this.blurTimer)
      this.blurTimer = setTimeout(() => {
        this.blurTimer = null
        if (!this.id) return
        const active = document.activeElement
        if (active && host.formatBar.contains(active)) return
        this.close(true)
      }, 0)
    })
    el.addEventListener('keydown', (event) => this.onKeyDown(event))
    el.addEventListener('input', () => {
      if (this.composing) return
      this.syncLocal()
    })
    el.addEventListener('beforeinput', (event) => this.onBeforeInput(event))
    el.addEventListener('paste', (event) => this.onPaste(event))
    el.addEventListener('compositionstart', () => {
      this.composing = true
      this.remoteDuringComposition = false
    })
    el.addEventListener('compositionend', () => {
      this.composing = false
      if (this.remoteDuringComposition) {
        this.host.toast(t('editor.remoteDuringComposition'))
      }
      this.syncLocal()
      this.remoteDuringComposition = false
    })
    el.addEventListener('drop', (event) => {
      const text = event.dataTransfer?.getData('text/plain')
      if (!text) return
      event.preventDefault()
      this.insertText(text)
    })

    bar.addEventListener('pointerdown', (event) => {
      const target = event.target as HTMLElement
      if (target.closest('button')) event.preventDefault()
    })
    bar.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-fmt]')
      const action = button?.dataset.fmt as FormatAction | undefined
      if (!action) return
      this.applyFormat(action)
    })
    this.sizeSelect.addEventListener('change', () => {
      const size = this.sizeSelect.value as NoteTextSize
      this.applyFormat('size', size)
    })
  }

  get editingId(): string | null {
    return this.id
  }

  isOpen(id?: string): boolean {
    return this.id !== null && (id === undefined || this.id === id)
  }

  open(id: string): void {
    if (this.id === id) return
    if (this.id) this.close(true)
    const note = this.host.getItem(id)
    if (!note) return
    this.host.board.ensureNoteLines(id)
    this.lines = this.host.board.noteLines(id)
    this.ylines = this.host.board.getYLines(id)
    if (!this.ylines) return
    this.id = id
    this.observer = () => this.onRemoteChange()
    this.ylines.observeDeep(this.observer)
    this.host.board.stopCapturing()

    const el = this.host.element
    el.hidden = false
    this.host.formatBar.hidden = false
    this.renderDom(this.lines)
    this.reposition()
    el.focus({ preventScroll: true })
    const last = this.lines[this.lines.length - 1]
    if (last) this.restoreSelection({ anchor: { lineId: last.id, offset: last.text.length }, focus: { lineId: last.id, offset: last.text.length } })
    document.addEventListener('selectionchange', this.onSelectionChange)
    this.host.onOpen(id)
    this.host.requestRender()
  }

  reposition(): void {
    if (!this.id) return
    const note = this.host.getItem(this.id)
    if (!note) {
      this.close(false)
      return
    }
    const cam = this.host.getCamera()
    const p = worldToScreen(cam, { x: note.x, y: note.y })
    const s = cam.scale
    const el = this.host.element
    el.style.left = `${p.x}px`
    el.style.top = `${p.y}px`
    el.style.width = `${Math.max(20, note.w * s)}px`
    el.style.height = `${Math.max(20, note.h * s)}px`
    el.style.padding = `${Math.max(6, 11 * s)}px ${Math.max(7, 12 * s)}px`
    el.style.background = note.color
    el.style.color = readableTextColor(note.color)
    el.style.borderRadius = `${Math.max(4, 8 * s)}px`
    this.applyScaleToLines()
    this.positionFormatBar(p.x, p.y, note.w * s, note.h * s)
  }

  close(commit = true): void {
    if (!this.id) return
    const id = this.id
    if (commit) this.syncLocal()
    if (this.blurTimer) clearTimeout(this.blurTimer)
    this.blurTimer = null
    document.removeEventListener('selectionchange', this.onSelectionChange)
    if (this.ylines && this.observer) this.ylines.unobserveDeep(this.observer)
    this.observer = null
    this.ylines = null
    this.id = null
    this.lines = []
    this.activeLineIds = []
    this.lastSelection = null
    this.composing = false
    this.remoteDuringComposition = false
    const el = this.host.element
    el.hidden = true
    el.innerHTML = ''
    this.host.formatBar.hidden = true
    this.host.board.stopCapturing()
    this.host.onClose(id)
    this.host.requestRender()
  }

  refresh(): void {
    if (!this.id) return
    const snapshot = this.captureSelection()
    this.lines = this.host.board.noteLines(this.id)
    this.renderDom(this.lines, snapshot ?? this.lastSelection)
    this.updateFormatState()
    this.reposition()
  }

  private lineFontSize(line: NoteLine): number {
    return NOTE_TEXT_SIZE_PX[line.size] ?? NOTE_TEXT_SIZE_PX[NOTE_DEFAULT_SIZE]
  }

  private lineElements(): HTMLElement[] {
    return [...this.host.element.querySelectorAll<HTMLElement>(':scope > .note-line')]
  }

  private renderDom(lines: NoteLine[], snapshot?: SelectionSnapshot | null): void {
    this.rendering = true
    const el = this.host.element
    el.innerHTML = ''
    const fragment = document.createDocumentFragment()
    for (const line of lines) {
      const node = document.createElement('div')
      node.className = 'note-line'
      node.dataset.lineId = line.id
      this.applyLinePresentation(node, line)
      node.textContent = line.text
      fragment.appendChild(node)
    }
    el.appendChild(fragment)
    this.updateMarkers()
    this.rendering = false
    if (snapshot) {
      el.focus({ preventScroll: true })
      this.restoreSelection(snapshot)
    }
  }

  private applyLinePresentation(node: HTMLElement, line: NoteLine): void {
    const s = this.host.getCamera().scale
    node.style.fontSize = `${Math.max(8, this.lineFontSize(line) * s)}px`
    node.style.fontWeight = line.bold ? '700' : '400'
    node.style.fontStyle = line.italic ? 'italic' : 'normal'
    const decoration: string[] = []
    if (line.underline) decoration.push('underline')
    if (line.strike) decoration.push('line-through')
    node.style.textDecorationLine = decoration.length ? decoration.join(' ') : 'none'
    node.style.textAlign = line.list === 'none' ? line.align : 'left'
    if (line.list === 'none') delete node.dataset.list
    else node.dataset.list = line.list
  }

  private applyScaleToLines(): void {
    for (const node of this.lineElements()) {
      const line = this.lines.find((item) => item.id === node.dataset.lineId)
      if (line) this.applyLinePresentation(node, line)
    }
  }

  private updateMarkers(): void {
    let ordered = 0
    for (const node of this.lineElements()) {
      const list = node.dataset.list
      if (list === 'ordered') {
        ordered += 1
        node.dataset.marker = `${ordered}.`
      } else {
        ordered = 0
        node.dataset.marker = list === 'bullet' ? '•' : ''
      }
    }
  }

  private positionFormatBar(x: number, y: number, w: number, h: number): void {
    const bar = this.host.formatBar
    if (bar.hidden) return
    const parent = this.host.element.parentElement
    const vw = parent?.clientWidth ?? window.innerWidth
    const vh = parent?.clientHeight ?? window.innerHeight
    const bw = bar.offsetWidth || 320
    const bh = bar.offsetHeight || 38
    let left = x + w / 2 - bw / 2
    left = Math.max(8, Math.min(vw - bw - 8, left))
    let top = y - bh - 10
    if (top < 8) top = y + h + 10
    top = Math.max(8, Math.min(vh - bh - 8, top))
    bar.style.left = `${left}px`
    bar.style.top = `${top}px`
  }

  private capturePoint(node: Node | null, offset: number): CaretPoint | null {
    if (!node || !this.host.element.contains(node)) return null
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
    const line = element?.closest<HTMLElement>('.note-line')
    if (!line || !this.host.element.contains(line)) return null
    const lineId = line.dataset.lineId
    if (!lineId) return null
    const range = document.createRange()
    range.selectNodeContents(line)
    try {
      range.setEnd(node, offset)
    } catch {
      return null
    }
    return { lineId, offset: range.toString().length }
  }

  private captureSelection(): SelectionSnapshot | null {
    const selection = document.getSelection()
    if (!selection || !selection.rangeCount) return null
    const anchor = this.capturePoint(selection.anchorNode, selection.anchorOffset)
    const focus = this.capturePoint(selection.focusNode, selection.focusOffset)
    if (!anchor || !focus) return null
    return { anchor, focus }
  }

  private domPoint(line: HTMLElement, offset: number): [Node, number] {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    let remaining = Math.max(0, offset)
    let node = walker.nextNode()
    if (!node) return [line, 0]
    while (node) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) return [node, remaining]
      remaining -= length
      node = walker.nextNode()
    }
    const last = line.lastChild
    if (last && last.nodeType === Node.TEXT_NODE) return [last, last.textContent?.length ?? 0]
    return [line, line.childNodes.length]
  }

  private restoreSelection(snapshot: SelectionSnapshot): void {
    const lines = this.lineElements()
    const find = (point: CaretPoint): HTMLElement | null =>
      lines.find((line) => line.dataset.lineId === point.lineId) ?? null
    const anchorLine = find(snapshot.anchor)
    const focusLine = find(snapshot.focus)
    const selection = document.getSelection()
    if (!selection || !anchorLine || !focusLine) return
    const [anchorNode, anchorOffset] = this.domPoint(anchorLine, snapshot.anchor.offset)
    const [focusNode, focusOffset] = this.domPoint(focusLine, snapshot.focus.offset)
    try {
      selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)
    } catch {
      // The DOM may have changed between restoring the two points.
    }
    this.lastSelection = snapshot
    this.activeLineIds = this.lineIdsInSnapshot(snapshot)
    this.updateFormatState()
  }

  private lineIdsInSnapshot(snapshot: SelectionSnapshot): string[] {
    const lines = this.lineElements()
    const start = lines.findIndex((line) => line.dataset.lineId === snapshot.anchor.lineId)
    const end = lines.findIndex((line) => line.dataset.lineId === snapshot.focus.lineId)
    if (start < 0 || end < 0) return []
    const from = Math.min(start, end)
    const to = Math.max(start, end)
    return lines.slice(from, to + 1).map((line) => line.dataset.lineId ?? '').filter(Boolean)
  }

  private lineElementAtSelection(): HTMLElement | null {
    const selection = document.getSelection()
    if (!selection || !selection.rangeCount) return null
    const node = selection.focusNode
    if (!node || !this.host.element.contains(node)) return null
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
    return element?.closest<HTMLElement>('.note-line') ?? null
  }

  private caretOffsetInLine(line: HTMLElement): number {
    const selection = document.getSelection()
    if (!selection || !selection.rangeCount) return 0
    const range = document.createRange()
    range.selectNodeContents(line)
    try {
      range.setEnd(selection.focusNode ?? line, selection.focusOffset)
    } catch {
      return 0
    }
    return range.toString().length
  }

  private lineText(node: HTMLElement): string {
    return (node.innerText || node.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r/g, '')
      .replace(/\n+$/, '')
  }

  private collectLines(): NoteLine[] {
    const root = this.host.element
    const direct = [...root.childNodes]
    const lineNodes = direct.filter(
      (node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains('note-line'),
    )
    const hasStrayContent = direct.some(
      (node) =>
        (node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())) ||
        (node instanceof HTMLElement && !node.classList.contains('note-line') && node.tagName !== 'BR'),
    )
    if (!lineNodes.length || hasStrayContent) {
      const text = (root.innerText || root.textContent || '').replace(/\u00a0/g, ' ').replace(/\r/g, '')
      const parts = text.split('\n')
      return parts.map((part, index) => {
        const previous = this.lines[index] ?? this.lines[this.lines.length - 1]
        return {
          ...(previous ?? this.blankLine()),
          id: previous?.id ?? uuid(),
          text: part,
        }
      })
    }
    const byId = new Map(this.lines.map((line) => [line.id, line]))
    const out: NoteLine[] = []
    let template = this.lines[0] ?? this.blankLine()
    for (const [index, node] of lineNodes.entries()) {
      const id = node.dataset.lineId
      const base = (id ? byId.get(id) : undefined) ?? this.lines[index] ?? template
      template = base
      const textParts = this.lineText(node).split('\n')
      for (const [partIndex, text] of textParts.entries()) {
        out.push({
          ...base,
          id: partIndex === 0 && id ? id : uuid(),
          text,
        })
      }
    }
    return out.length ? out : [this.blankLine()]
  }

  private blankLine(): NoteLine {
    return {
      id: uuid(),
      text: '',
      size: NOTE_DEFAULT_SIZE,
      bold: false,
      italic: false,
      underline: false,
      strike: false,
      list: 'none',
      align: 'left',
    }
  }

  private setLocalLines(lines: NoteLine[], snapshot?: SelectionSnapshot | null): void {
    if (!this.id) return
    this.suppressing = true
    try {
      this.host.board.setNoteLines(this.id, lines)
    } finally {
      this.suppressing = false
    }
    this.lines = this.host.board.noteLines(this.id)
    this.renderDom(this.lines, snapshot ?? null)
    if (!snapshot) {
      const last = this.lines[this.lines.length - 1]
      if (last) this.restoreSelection({ anchor: { lineId: last.id, offset: last.text.length }, focus: { lineId: last.id, offset: last.text.length } })
    }
    this.host.requestRender()
  }

  private syncLocal(force = false): void {
    if (!this.id || this.suppressing) return
    if (this.composing && !force) return
    const hadStructure = this.lineElements().length > 0
    const next = this.collectLines()
    this.suppressing = true
    try {
      this.host.board.setNoteLines(this.id, next)
    } finally {
      this.suppressing = false
    }
    this.lines = this.host.board.noteLines(this.id)
    const nodes = this.lineElements()
    for (const [index, node] of nodes.entries()) {
      const line = this.lines[index]
      if (!line) break
      node.dataset.lineId = line.id
      this.applyLinePresentation(node, line)
    }
    if (!hadStructure || nodes.length !== this.lines.length) {
      const snapshot = this.captureSelection()
      this.renderDom(this.lines, snapshot)
    }
    this.updateMarkers()
    this.updateFormatState()
    this.host.requestRender()
  }

  private onRemoteChange(): void {
    if (!this.id || this.suppressing) return
    if (this.composing) {
      this.remoteDuringComposition = true
      return
    }
    const snapshot = this.captureSelection() ?? this.lastSelection
    this.lines = this.host.board.noteLines(this.id)
    this.renderDom(this.lines, snapshot)
    this.updateFormatState()
    this.host.requestRender()
  }

  private onSelectionChange = (): void => {
    if (!this.id || this.rendering) return
    const selection = document.getSelection()
    if (!selection || !selection.rangeCount) return
    const range = selection.getRangeAt(0)
    const inside = this.host.element.contains(range.commonAncestorContainer)
    if (!inside) {
      if (document.activeElement && this.host.formatBar.contains(document.activeElement)) return
      return
    }
    const snapshot = this.captureSelection()
    if (!snapshot) return
    this.lastSelection = snapshot
    this.activeLineIds = this.selectionLineIds(range, snapshot)
    this.updateFormatState()
  }

  private selectionLineIds(range: Range, snapshot: SelectionSnapshot): string[] {
    if (range.collapsed) return [snapshot.focus.lineId]
    return this.lineElements()
      .filter((line) => {
        try {
          return range.intersectsNode(line)
        } catch {
          return false
        }
      })
      .map((line) => line.dataset.lineId ?? '')
      .filter(Boolean)
  }

  private updateFormatState(): void {
    const lines = this.activeLineIds
      .map((id) => this.lines.find((line) => line.id === id))
      .filter((line): line is NoteLine => Boolean(line))
    const all = (predicate: (line: NoteLine) => boolean): boolean => lines.length > 0 && lines.every(predicate)
    const button = (name: string): HTMLElement | null =>
      this.host.formatBar.querySelector<HTMLElement>(`[data-fmt="${name}"]`)
    const setActive = (name: string, active: boolean): void => {
      const node = button(name)
      if (!node) return
      node.classList.toggle('active', active)
      node.setAttribute('aria-pressed', String(active))
    }
    setActive('bold', all((line) => line.bold))
    setActive('italic', all((line) => line.italic))
    setActive('underline', all((line) => line.underline))
    setActive('strike', all((line) => line.strike))
    setActive('bullet', all((line) => line.list === 'bullet'))
    setActive('ordered', all((line) => line.list === 'ordered'))
    setActive('align-left', all((line) => line.align === 'left'))
    setActive('align-center', all((line) => line.align === 'center'))
    setActive('align-right', all((line) => line.align === 'right'))
    if (lines.length) this.sizeSelect.value = lines[0].size
  }

  private activeLines(): NoteLine[] {
    const ids = this.activeLineIds.length
      ? this.activeLineIds
      : this.lastSelection
        ? this.lineIdsInSnapshot(this.lastSelection)
        : []
    return ids
      .map((id) => this.lines.find((line) => line.id === id))
      .filter((line): line is NoteLine => Boolean(line))
  }

  private applyFormat(action: FormatAction | 'size', size?: NoteTextSize): void {
    if (!this.id) return
    const lines = this.activeLines()
    if (!lines.length) return
    const ids = lines.map((line) => line.id)
    const patch: Partial<Pick<NoteLine, 'size' | 'bold' | 'italic' | 'underline' | 'strike' | 'list' | 'align'>> = {}
    if (action === 'size' && size) patch.size = size
    else if (action === 'bold') patch.bold = !lines.every((line) => line.bold)
    else if (action === 'italic') patch.italic = !lines.every((line) => line.italic)
    else if (action === 'underline') patch.underline = !lines.every((line) => line.underline)
    else if (action === 'strike') patch.strike = !lines.every((line) => line.strike)
    else if (action === 'bullet') patch.list = lines.every((line) => line.list === 'bullet') ? 'none' : 'bullet'
    else if (action === 'ordered') patch.list = lines.every((line) => line.list === 'ordered') ? 'none' : 'ordered'
    else if (action === 'align-left') patch.align = 'left'
    else if (action === 'align-center') patch.align = 'center'
    else if (action === 'align-right') patch.align = 'right'
    else if (action === 'clear') {
      patch.size = NOTE_DEFAULT_SIZE
      patch.bold = false
      patch.italic = false
      patch.underline = false
      patch.strike = false
      patch.list = 'none'
      patch.align = 'left'
    }
    this.suppressing = true
    try {
      this.host.board.setLineAttrs(this.id, ids, patch)
    } finally {
      this.suppressing = false
    }
    this.lines = this.host.board.noteLines(this.id)
    const nodes = this.lineElements()
    for (const node of nodes) {
      const line = this.lines.find((item) => item.id === node.dataset.lineId)
      if (line) this.applyLinePresentation(node, line)
    }
    this.updateMarkers()
    this.updateFormatState()
    this.host.board.stopCapturing()
    this.host.requestRender()
    if (document.activeElement !== this.host.element) {
      this.host.element.focus({ preventScroll: true })
      if (this.lastSelection) this.restoreSelection(this.lastSelection)
    }
  }

  private splitLine(): void {
    if (!this.id) return
    const selection = document.getSelection()
    if (!selection || !selection.rangeCount) return
    const range = selection.getRangeAt(0)
    if (!this.host.element.contains(range.commonAncestorContainer)) return
    if (!range.collapsed) range.deleteContents()
    const lineEl = this.lineElementAtSelection()
    if (!lineEl) {
      document.execCommand('insertParagraph')
      this.syncLocal()
      return
    }
    const lineId = lineEl.dataset.lineId
    const offset = this.caretOffsetInLine(lineEl)
    const lines = this.collectLines()
    const index = lines.findIndex((line) => line.id === lineId)
    if (index < 0) return
    const current = lines[index]
    if (!current.text && current.list !== 'none' && offset === 0) {
      const plain = { ...current, list: 'none' as NoteListStyle }
      lines[index] = plain
      this.setLocalLines(lines, {
        anchor: { lineId: plain.id, offset: 0 },
        focus: { lineId: plain.id, offset: 0 },
      })
      return
    }
    const before = current.text.slice(0, offset)
    const after = current.text.slice(offset)
    const nextLine: NoteLine = { ...current, id: uuid(), text: after }
    lines[index] = { ...current, text: before }
    lines.splice(index + 1, 0, nextLine)
    this.setLocalLines(lines, {
      anchor: { lineId: nextLine.id, offset: 0 },
      focus: { lineId: nextLine.id, offset: 0 },
    })
  }

  private mergeLine(backward: boolean): boolean {
    if (!this.id) return false
    const selection = document.getSelection()
    if (!selection || !selection.rangeCount || !selection.isCollapsed) return false
    const currentEl = this.lineElementAtSelection()
    if (!currentEl) return false
    const offset = this.caretOffsetInLine(currentEl)
    const currentText = this.lineText(currentEl)
    if (backward && offset !== 0) return false
    if (!backward && offset !== currentText.length) return false
    const target = (backward ? currentEl.previousElementSibling : currentEl.nextElementSibling) as HTMLElement | null
    if (!target || !target.classList.contains('note-line')) return false
    const lines = this.collectLines()
    const currentId = currentEl.dataset.lineId
    const targetId = target.dataset.lineId
    const currentIndex = lines.findIndex((line) => line.id === currentId)
    const targetIndex = lines.findIndex((line) => line.id === targetId)
    if (currentIndex < 0 || targetIndex < 0) return false
    const current = lines[currentIndex]
    const merged = lines[targetIndex]
    if (backward) {
      const caret = merged.text.length
      const nextTarget = { ...merged, text: merged.text + current.text }
      lines[targetIndex] = nextTarget
      lines.splice(currentIndex, 1)
      this.setLocalLines(lines, {
        anchor: { lineId: nextTarget.id, offset: caret },
        focus: { lineId: nextTarget.id, offset: caret },
      })
    } else {
      const caret = merged.text.length
      const nextCurrent = { ...current, text: current.text + merged.text }
      lines[currentIndex] = nextCurrent
      lines.splice(targetIndex, 1)
      this.setLocalLines(lines, {
        anchor: { lineId: nextCurrent.id, offset: caret },
        focus: { lineId: nextCurrent.id, offset: caret },
      })
    }
    return true
  }

  private insertText(text: string): void {
    if (!this.id || !text) return
    const selection = document.getSelection()
    if (!selection || !selection.rangeCount) return
    const range = selection.getRangeAt(0)
    if (!this.host.element.contains(range.commonAncestorContainer)) return
    if (!range.collapsed) range.deleteContents()
    const el = this.lineElementAtSelection()
    const point = this.captureSelection()?.focus ?? null
    if (!el || !point) {
      document.execCommand('insertText', false, text)
      this.syncLocal()
      return
    }
    const lines = this.collectLines()
    const index = lines.findIndex((line) => line.id === point.lineId)
    if (index < 0) return
    const line = lines[index]
    const before = line.text.slice(0, point.offset)
    const after = line.text.slice(point.offset)
    const parts = text.replace(/\r\n?/g, '\n').split('\n')
    const inserted: NoteLine[] = []
    let target = { lineId: line.id, offset: 0 }
    lines[index] = { ...line, text: before + parts[0] }
    if (parts.length === 1) {
      target = { lineId: line.id, offset: before.length + parts[0].length }
    } else {
      for (let i = 1; i < parts.length; i++) {
        const newLine: NoteLine = {
          ...line,
          id: uuid(),
          text: i === parts.length - 1 ? parts[i] + after : parts[i],
        }
        inserted.push(newLine)
        target = { lineId: newLine.id, offset: parts[i].length }
      }
      lines.splice(index + 1, 0, ...inserted)
    }
    this.setLocalLines(lines, { anchor: target, focus: target })
  }

  private onPaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData('text/plain')
    if (!text) return
    event.preventDefault()
    this.insertText(text)
  }

  private onBeforeInput(event: InputEvent): void {
    if (this.composing) return
    if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
      event.preventDefault()
      this.splitLine()
      return
    }
    if (event.inputType === 'formatBold') {
      event.preventDefault()
      this.applyFormat('bold')
    } else if (event.inputType === 'formatItalic') {
      event.preventDefault()
      this.applyFormat('italic')
    } else if (event.inputType === 'formatUnderline') {
      event.preventDefault()
      this.applyFormat('underline')
    } else if (event.inputType === 'formatStrikeThrough') {
      event.preventDefault()
      this.applyFormat('strike')
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    event.stopPropagation()
    if (this.composing) return
    const mod = event.ctrlKey || event.metaKey
    if (event.key === 'Escape') {
      event.preventDefault()
      this.close(true)
      return
    }
    if (event.key === 'Enter' && mod) {
      event.preventDefault()
      this.close(true)
      return
    }
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) this.host.redo()
      else this.host.undo()
      this.refresh()
      return
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      this.host.redo()
      this.refresh()
      return
    }
    if (mod && ['b', 'i', 'u'].includes(event.key.toLowerCase())) {
      event.preventDefault()
      const key = event.key.toLowerCase()
      this.applyFormat(key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'underline')
      return
    }
    if (mod && event.shiftKey && event.key.toLowerCase() === 'x') {
      event.preventDefault()
      this.applyFormat('strike')
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      this.splitLine()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      this.insertText('  ')
      return
    }
    if (event.key === 'Backspace') {
      if (this.mergeLine(true)) event.preventDefault()
      return
    }
    if (event.key === 'Delete') {
      if (this.mergeLine(false)) event.preventDefault()
    }
  }
}
