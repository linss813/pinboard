import type * as Y from 'yjs'
import type { Board } from './board'
import { applyTextDiff } from './board'
import type { TextItem } from '../shared/types'
import type { Camera } from '../shared/geometry'
import { worldToScreen } from '../shared/geometry'
import { t } from './i18n'

export interface TextEditorHost {
  board: Board
  textarea: HTMLTextAreaElement
  getCamera(): Camera
  getItem(id: string): TextItem | null
  onOpen(id: string): void
  onClose(id: string): void
  requestRender(): void
  undo(): void
  redo(): void
  toast(message: string): void
}

function mapCaret(value: string, next: string, caret: number): number {
  if (value === next) return Math.min(caret, next.length)
  let start = 0
  const min = Math.min(value.length, next.length)
  while (start < min && value[start] === next[start]) start++
  let endPrev = value.length
  let endNext = next.length
  while (endPrev > start && endNext > start && value[endPrev - 1] === next[endNext - 1]) {
    endPrev--
    endNext--
  }
  if (caret <= start) return caret
  if (caret >= endPrev) return Math.max(0, Math.min(next.length, caret + (endNext - start) - (endPrev - start)))
  return start + Math.min(caret - start, endNext - start)
}

export class TextBoxEditor {
  private id: string | null = null
  private ytext: Y.Text | null = null
  private observer: (() => void) | null = null
  private composing = false
  private suppressing = false
  private remoteDuringComposition = false

  constructor(private readonly host: TextEditorHost) {
    const ta = host.textarea
    ta.addEventListener('blur', () => this.close(true))
    ta.addEventListener('keydown', (event) => this.onKeyDown(event))
    ta.addEventListener('input', () => {
      if (this.composing) return
      this.syncLocal()
    })
    ta.addEventListener('compositionstart', () => {
      this.composing = true
      this.remoteDuringComposition = false
    })
    ta.addEventListener('compositionend', () => {
      this.composing = false
      if (this.remoteDuringComposition) this.host.toast(t('editor.remoteDuringComposition'))
      this.remoteDuringComposition = false
      this.syncLocal()
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
    const item = this.host.getItem(id)
    if (!item) return
    const ytext = this.host.board.getYText(id)
    if (!ytext) return
    this.id = id
    this.ytext = ytext
    this.observer = () => this.onRemoteChange()
    ytext.observe(this.observer)
    this.host.board.stopCapturing()
    const ta = this.host.textarea
    ta.value = ytext.toString()
    ta.hidden = false
    ta.placeholder = t('editor.textPlaceholder')
    this.reposition()
    ta.focus({ preventScroll: true })
    const end = ta.value.length
    ta.setSelectionRange(end, end)
    this.host.onOpen(id)
    this.host.requestRender()
  }

  reposition(): void {
    if (!this.id) return
    const item = this.host.getItem(this.id)
    if (!item) {
      this.close(false)
      return
    }
    const cam = this.host.getCamera()
    const p = worldToScreen(cam, { x: item.x, y: item.y })
    const scale = cam.scale
    const ta = this.host.textarea
    ta.style.left = `${p.x}px`
    ta.style.top = `${p.y}px`
    ta.style.width = `${Math.max(20, item.w * scale)}px`
    ta.style.height = `${Math.max(24, item.h * scale)}px`
    ta.style.padding = `${Math.max(3, 5 * scale)}px ${Math.max(4, 7 * scale)}px`
    ta.style.fontSize = `${Math.max(9, item.fontSize * scale)}px`
    ta.style.lineHeight = '1.35'
    ta.style.color = item.color
    ta.style.borderRadius = `${Math.max(3, 6 * scale)}px`
  }

  close(commit = true): void {
    if (!this.id) return
    const id = this.id
    if (commit) this.syncLocal(true)
    if (this.ytext && this.observer) this.ytext.unobserve(this.observer)
    this.observer = null
    this.ytext = null
    this.id = null
    this.composing = false
    this.remoteDuringComposition = false
    const ta = this.host.textarea
    ta.hidden = true
    ta.value = ''
    this.host.board.stopCapturing()
    this.host.onClose(id)
    this.host.requestRender()
  }

  refresh(): void {
    if (!this.id || !this.ytext) return
    const value = this.ytext.toString()
    if (this.host.textarea.value !== value) {
      const start = this.host.textarea.selectionStart ?? value.length
      const end = this.host.textarea.selectionEnd ?? value.length
      const old = this.host.textarea.value
      this.host.textarea.value = value
      this.host.textarea.setSelectionRange(mapCaret(old, value, start), mapCaret(old, value, end))
    }
    this.reposition()
  }

  private onKeyDown(event: KeyboardEvent): void {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      this.close(true)
      return
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      this.close(true)
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) this.host.redo()
      else this.host.undo()
      this.refresh()
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      this.host.redo()
      this.refresh()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      const ta = this.host.textarea
      ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end')
      this.syncLocal()
    }
  }

  private syncLocal(force = false): void {
    if (!this.ytext || this.suppressing) return
    if (this.composing && !force) return
    const next = this.host.textarea.value
    if (next === this.ytext.toString()) return
    this.suppressing = true
    try {
      applyTextDiff(this.ytext, next)
    } finally {
      this.suppressing = false
    }
    this.growToFit()
    this.host.requestRender()
  }

  private growToFit(): void {
    if (!this.id || this.composing) return
    const item = this.host.getItem(this.id)
    if (!item) return
    const ta = this.host.textarea
    requestAnimationFrame(() => {
      if (!this.id) return
      const scale = this.host.getCamera().scale
      if (ta.scrollHeight <= ta.clientHeight + 1) return
      const height = Math.ceil(ta.scrollHeight / scale)
      if (height <= item.h + 1) return
      this.host.board.setBoxRect(this.id, { h: height })
      this.reposition()
      this.host.requestRender()
    })
  }

  private onRemoteChange(): void {
    if (!this.ytext || this.suppressing) return
    if (this.composing) {
      this.remoteDuringComposition = true
      return
    }
    const next = this.ytext.toString()
    const ta = this.host.textarea
    if (ta.value === next) return
    const start = ta.selectionStart ?? next.length
    const end = ta.selectionEnd ?? next.length
    const old = ta.value
    ta.value = next
    ta.setSelectionRange(mapCaret(old, next, start), mapCaret(old, next, end))
    this.host.requestRender()
  }
}
