import type { Item, NoteItem, PeerUser, Rect } from '../shared/types'
import { NOTE_COLORS, REACTIONS } from '../shared/constants'
import type { Tool } from './scene'
import { formatPinnedTime, t, type MessageKey } from './i18n'
import { initials, truncate } from './util'
import type { AssetStore } from './assets'

function $<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector)
  if (!node) throw new Error(`Missing element: ${selector}`)
  return node
}

export const dom = {
  app: $('#app'),
  header: $('header'),
  viewport: $('#viewport'),
  canvas: $('#board') as HTMLCanvasElement,
  minimap: $('#minimap') as HTMLCanvasElement,
  minimapDock: $('#minimapDock'),
  btnMinimapToggle: $('#btnMinimapToggle'),
  btnMinimapShow: $('#btnMinimapShow'),
  editor: $('#editor'),
  formatBar: $('#formatBar'),
  toolbar: $('#toolbar'),
  penOpts: $('#penOpts'),
  penPressure: $('#penPressure') as HTMLInputElement,
  penPressureControl: $('#penPressureControl'),
  penPressureLabel: $('#penPressureLabel'),
  noteOpts: $('#noteOpts'),
  noteCustomColor: $('#noteCustomColor') as HTMLInputElement,
  textOpts: $('#textOpts'),
  textSwatches: $('#textSwatches'),
  textSizes: $('#textSizes'),
  textCustomColor: $('#textCustomColor') as HTMLInputElement,
  textEditor: $('#textEditor') as HTMLTextAreaElement,
  penSwatches: $('#penSwatches'),
  noteSwatches: $('#noteSwatches'),
  penModes: $('#penModes'),
  penCustomColor: $('#penCustomColor') as HTMLInputElement,
  penWidth: $('#penWidth') as HTMLInputElement,
  penWidthLabel: $('#penWidthLabel'),
  zoomLabel: $('#zoomLabel'),
  zoomIn: $('#zoomIn'),
  zoomOut: $('#zoomOut'),
  zoomFit: $('#zoomFit'),
  btnPinPanel: $('#btnPinPanel'),
  pinCount: $('#pinCount'),
  pinPanel: $('#pinnedPanel'),
  panelCount: $('#panelCount'),
  btnClosePanel: $('#btnClosePanel'),
  pinSearch: $('#pinSearch') as HTMLInputElement,
  pinList: $('#pinList'),
  pinEmpty: $('#pinEmpty'),
  btnReactions: $('#btnReactions'),
  reactionPalette: $('#reactionPalette'),
  btnShare: $('#btnShare'),
  avatars: $('#avatars'),
  connState: $('#connState'),
  roomTitle: $('#roomTitle') as HTMLInputElement,
  selectionBar: $('#selectionBar'),
  ctxMenu: $('#ctxMenu'),
  btnMenu: $('#btnMenu'),
  menu: $('#menu'),
  followBanner: $('#followBanner'),
  followName: $('#followName'),
  followAvatar: $('#followAvatar'),
  btnStopFollow: $('#btnStopFollow'),
  toasts: $('#toasts'),
  nameModal: $('#nameModal'),
  nameForm: $('#nameForm') as HTMLFormElement,
  nameInput: $('#nameInput') as HTMLInputElement,
  nameModalTitle: $('#nameModalTitle'),
  nameModalSubtitle: $('#nameModalSubtitle'),
  nameSubmit: $('#nameSubmit'),
  nameNote: $('#nameNote'),
  btnCloseName: $('#btnCloseName'),
  joinRoomId: $('#joinRoomId'),
  fileInput: $('#fileInput') as HTMLInputElement,
  jsonInput: $('#jsonInput') as HTMLInputElement,
  dropOverlay: $('#dropOverlay'),
  btnGuide: $('#btnGuide'),
  guideModal: $('#guideModal'),
  guideSections: $('#guideSections'),
  btnCloseGuide: $('#btnCloseGuide'),
  settingsModal: $('#settingsModal'),
  btnCloseSettings: $('#btnCloseSettings'),
  optDoubleClick: $('#optDoubleClick') as HTMLInputElement,
  optMinimap: $('#optMinimap') as HTMLInputElement,
}

export type SelectionBarOptions = {
  pinLabel: string
  pinDisabled: boolean
  pinActive: boolean
  deleteDisabled: boolean
  canDelete: boolean
  editVisible: boolean
  editTitle: string
  groupLabel: string
  groupDisabled: boolean
  groupIsUngroup: boolean
}

export type ContextMenuOptions = {
  x: number
  y: number
  color?: {
    current: string
    colors?: readonly string[]
    allowCustom?: boolean
    onPick: (color: string) => void
  }
  title?: string
  actions: {
    label: string
    hint?: string
    danger?: boolean
    disabled?: boolean
    icon?: string
    action: () => void
  }[]
}

let toastCounter = 0
export function toast(message: string, duration = 2400): void {
  const active = [...dom.toasts.querySelectorAll<HTMLElement>('.toast:not(.out)')]
  if (active.length >= 3) {
    for (const old of active.slice(0, active.length - 2)) old.remove()
  }
  const node = document.createElement('div')
  node.className = 'toast'
  node.textContent = message
  node.dataset.toastId = String(++toastCounter)
  dom.toasts.appendChild(node)
  setTimeout(() => {
    node.classList.add('out')
    setTimeout(() => node.remove(), 240)
  }, duration)
}

export function setConnection(state: 'online' | 'waiting' | 'offline', label: string): void {
  dom.connState.classList.toggle('is-online', state === 'online')
  dom.connState.classList.toggle('is-waiting', state === 'waiting')
  dom.connState.classList.toggle('is-offline', state === 'offline')
  const text = dom.connState.querySelector('span')
  if (text) text.textContent = label
}

export function setZoom(scale: number): void {
  dom.zoomLabel.textContent = `${Math.round(scale * 100)}%`
}

export function setToolUi(tool: Tool): void {
  dom.toolbar.querySelectorAll<HTMLElement>('.tbtn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tool === tool)
  })
  dom.penOpts.classList.toggle('show', tool === 'pen')
  dom.noteOpts.classList.toggle('show', tool === 'note')
  dom.textOpts.classList.toggle('show', tool === 'text')
}

export function setTextOptionsVisible(visible: boolean): void {
  dom.textOpts.classList.toggle('show', visible)
}

export function buildSwatches(
  container: HTMLElement,
  colors: readonly string[],
  current: string,
  onPick: (color: string) => void,
): void {
  container.innerHTML = ''
  for (const color of colors) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `sw${color === current ? ' on' : ''}`
    button.style.background = color
    button.setAttribute('aria-label', t('colorAria', { color }))
    button.addEventListener('click', () => {
      container.querySelectorAll('.sw').forEach((s) => s.classList.remove('on'))
      button.classList.add('on')
      onPick(color)
    })
    container.appendChild(button)
  }
}

export function setSwatchSelection(container: HTMLElement, colors: readonly string[], current: string): void {
  container.querySelectorAll<HTMLElement>('.sw').forEach((node, index) => {
    node.classList.toggle('on', colors[index] === current)
  })
}

export function updatePinCount(count: number): void {
  dom.pinCount.textContent = String(count)
  dom.pinCount.classList.toggle('has-items', count > 0)
  dom.panelCount.textContent = String(count)
}

export function setPinnedPanel(open: boolean): void {
  dom.pinPanel.hidden = !open
  dom.viewport.classList.toggle('panel-open', open)
  dom.btnPinPanel.classList.toggle('active', open)
}

export function isPinnedPanelOpen(): boolean {
  return !dom.pinPanel.hidden
}

export function renderPinnedList(options: {
  items: Item[]
  notes: Map<string, NoteItem>
  search: string
  assets: AssetStore
  onLocate: (id: string) => void
  onUnpin: (id: string) => void
  onHover: (id: string | null) => void
}): void {
  const query = options.search.trim().toLowerCase()
  const pinned = options.items
    .filter((item) => item.pinned && !item.deleted && item.type !== 'connector')
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.z - a.z)
    .filter((item) => {
      if (!query) return true
      if (item.type === 'note' || item.type === 'text') return item.text.toLowerCase().includes(query)
      if (item.type === 'image') return `${t('type.image')} 图片 圖片 image`.toLowerCase().includes(query)
      if (item.type === 'stroke') return `${t('type.stroke')} 笔迹 筆跡 画笔 畫筆 drawing stroke`.toLowerCase().includes(query)
      return false
    })

  dom.pinList.innerHTML = ''
  dom.pinEmpty.hidden = pinned.length > 0 || Boolean(query)
  if (!pinned.length) {
    if (query) {
      const no = document.createElement('div')
      no.className = 'pin-no-result'
      no.textContent = t('pinned.noResults')
      dom.pinList.appendChild(no)
    }
    return
  }

  for (const item of pinned) {
    const row = document.createElement('div')
    row.className = 'pin-item'
    row.dataset.pinId = item.id
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    const thumb = document.createElement('div')
    thumb.className = 'pin-thumb'
    if (item.type === 'image') {
      void options.assets.ensure(item.assetId)
      const img = document.createElement('img')
      img.src = options.assets.displayUrl(item.assetId)
      img.alt = ''
      img.loading = 'lazy'
      img.onerror = () => {
        img.remove()
        thumb.innerHTML = imageIcon
      }
      thumb.appendChild(img)
    } else if (item.type === 'note') {
      thumb.style.background = item.color
      thumb.innerHTML = noteIcon
    } else if (item.type === 'text') {
      thumb.style.color = item.color
      thumb.innerHTML = textIcon
    } else {
      thumb.innerHTML = penIcon
    }

    const body = document.createElement('div')
    body.className = 'pin-body'
    const text = document.createElement('div')
    text.className = 'pin-text'
    if (item.type === 'note') {
      text.textContent = truncate(item.text) || t('type.emptyNote')
      if (!item.text.trim()) text.classList.add('placeholder')
    } else if (item.type === 'text') {
      text.textContent = truncate(item.text) || t('type.emptyText')
      if (!item.text.trim()) text.classList.add('placeholder')
    } else if (item.type === 'image') {
      text.textContent = t('type.image')
    } else {
      text.textContent = t('type.stroke')
    }
    const meta = document.createElement('div')
    meta.className = 'pin-meta'
    const dot = document.createElement('span')
    dot.className = 'type-dot'
    dot.style.background =
      item.type === 'note' ? item.color : item.type === 'text' ? item.color : item.type === 'image' ? '#a5b4fc' : '#94a3b8'
    const metaText = document.createElement('span')
    metaText.textContent = formatPinnedTime(item.pinnedAt)
    meta.append(dot, metaText)
    body.append(text, meta)

    const actions = document.createElement('div')
    actions.className = 'pin-actions'
    const locate = document.createElement('button')
    locate.type = 'button'
    locate.title = t('pinned.locate')
    locate.setAttribute('aria-label', t('pinned.locate'))
    locate.innerHTML = locateIcon
    locate.addEventListener('click', (event) => {
      event.stopPropagation()
      options.onLocate(item.id)
    })
    const unpin = document.createElement('button')
    unpin.type = 'button'
    unpin.title = t('pinned.unpin')
    unpin.setAttribute('aria-label', t('pinned.unpin'))
    unpin.innerHTML = pinOffIcon
    unpin.addEventListener('click', (event) => {
      event.stopPropagation()
      options.onUnpin(item.id)
    })
    actions.append(locate, unpin)
    row.append(thumb, body, actions)
    row.addEventListener('click', () => options.onLocate(item.id))
    row.addEventListener('mouseenter', () => options.onHover(item.id))
    row.addEventListener('mouseleave', () => options.onHover(null))
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        options.onLocate(item.id)
      }
    })
    dom.pinList.appendChild(row)
  }
}

export function showSelectionBar(rect: Rect | null, options: SelectionBarOptions): void {
  if (!rect) {
    dom.selectionBar.hidden = true
    return
  }
  const pin = dom.selectionBar.querySelector<HTMLButtonElement>('[data-sel-action="pin"]')
  const del = dom.selectionBar.querySelector<HTMLButtonElement>('[data-sel-action="delete"]')
  const edit = dom.selectionBar.querySelector<HTMLButtonElement>('[data-sel-action="edit"]')
  const group = dom.selectionBar.querySelector<HTMLButtonElement>('[data-sel-action="group"]')
  if (edit) {
    edit.hidden = !options.editVisible
    edit.title = options.editTitle
  }
  if (group) {
    group.disabled = options.groupDisabled
    group.classList.toggle('active', options.groupIsUngroup)
    const label = group.querySelector('span')
    if (label) label.textContent = options.groupLabel
  }
  if (pin) {
    pin.disabled = options.pinDisabled
    const label = pin.querySelector('span')
    if (label) label.textContent = options.pinLabel
    pin.classList.toggle('active', options.pinActive)
  }
  if (del) {
    del.disabled = options.deleteDisabled || !options.canDelete
  }
  dom.selectionBar.hidden = false
  const bar = dom.selectionBar
  const bw = bar.offsetWidth || 270
  const bh = bar.offsetHeight || 38
  const vw = dom.viewport.clientWidth
  const vh = dom.viewport.clientHeight
  let left = rect.x + rect.w / 2 - bw / 2
  left = Math.max(8, Math.min(vw - bw - 8, left))
  let top = rect.y - bh - 42
  if (top < 8) top = Math.min(vh - bh - 8, rect.y + rect.h + 14)
  bar.style.left = `${left}px`
  bar.style.top = `${top}px`
}

export function hideSelectionBar(): void {
  dom.selectionBar.hidden = true
}

export function showContextMenu(options: ContextMenuOptions): void {
  const menu = dom.ctxMenu
  menu.innerHTML = ''
  menu.hidden = false
  if (options.title) {
    const label = document.createElement('div')
    label.className = 'menu-label'
    label.textContent = options.title
    menu.appendChild(label)
  }
  if (options.color) {
    const row = document.createElement('div')
    row.className = 'colors'
    for (const color of options.color.colors ?? NOTE_COLORS) {
      const sw = document.createElement('div')
      sw.className = 'c'
      sw.style.background = color
      if (color === options.color.current) sw.style.outline = '2px solid #4f8ef7'
      sw.addEventListener('click', () => {
        options.color!.onPick(color)
        hideContextMenu()
      })
      row.appendChild(sw)
    }
    if (options.color.allowCustom) {
      const input = document.createElement('input')
      input.type = 'color'
      input.className = 'color-custom'
      input.value = options.color.current
      input.title = t('color.custom')
      input.setAttribute('aria-label', t('color.custom'))
      input.addEventListener('change', () => {
        options.color!.onPick(input.value)
        hideContextMenu()
      })
      row.appendChild(input)
    }
    menu.appendChild(row)
    const sep = document.createElement('div')
    sep.className = 'sep'
    menu.appendChild(sep)
  }
  for (const action of options.actions) {
    const button = document.createElement('button')
    button.type = 'button'
    button.innerHTML = `${action.icon ?? ''}<span>${action.label}</span>${action.hint ? `<span class="ctx-hint">${action.hint}</span>` : ''}`
    button.classList.toggle('danger', Boolean(action.danger))
    button.disabled = Boolean(action.disabled)
    button.addEventListener('click', () => {
      if (button.disabled) return
      hideContextMenu()
      action.action()
    })
    menu.appendChild(button)
  }
  const mw = menu.offsetWidth || 190
  const mh = menu.offsetHeight || 120
  menu.style.left = `${Math.min(options.x, window.innerWidth - mw - 10)}px`
  menu.style.top = `${Math.min(options.y, window.innerHeight - mh - 10)}px`
}

export function hideContextMenu(): void {
  dom.ctxMenu.hidden = true
}

export function isContextMenuOpen(): boolean {
  return !dom.ctxMenu.hidden
}

export function buildReactionPalette(onPick: (kind: string) => void): void {
  dom.reactionPalette.innerHTML = ''
  REACTIONS.forEach((kind, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'react'
    button.dataset.kind = kind
    button.innerHTML = `${kind}<span class="react-count" hidden></span><kbd>${index + 1}</kbd>`
    button.title = t('reaction.sendTitle')
    button.setAttribute('aria-label', t('reaction.sendAria', { emoji: kind }))
    button.addEventListener('click', () => onPick(kind))
    dom.reactionPalette.appendChild(button)
  })
}

export function resetReactionPaletteCounts(): void {
  dom.reactionPalette.querySelectorAll<HTMLElement>('.react').forEach((button) => {
    button.classList.remove('active')
    const count = button.querySelector<HTMLElement>('.react-count')
    if (count) {
      count.hidden = true
      count.textContent = ''
    }
  })
}

export function setReactionPaletteCount(kind: string, count: number): void {
  resetReactionPaletteCounts()
  const button = [...dom.reactionPalette.querySelectorAll<HTMLElement>('.react')].find(
    (item) => item.dataset.kind === kind,
  )
  if (!button) return
  button.classList.add('active')
  const badge = button.querySelector<HTMLElement>('.react-count')
  if (badge && count > 1) {
    badge.hidden = false
    badge.textContent = `×${count}`
  }
}

export function showReactionPalette(x: number, y: number): void {
  resetReactionPaletteCounts()
  dom.reactionPalette.hidden = false
  const w = dom.reactionPalette.offsetWidth || 260
  const h = dom.reactionPalette.offsetHeight || 50
  dom.reactionPalette.style.left = `${Math.max(16, Math.min(window.innerWidth - w - 8, x - w / 2))}px`
  dom.reactionPalette.style.top = `${Math.max(62, Math.min(window.innerHeight - h - 8, y + 16))}px`
}

export function hideReactionPalette(): void {
  dom.reactionPalette.hidden = true
  resetReactionPaletteCounts()
}

export function isReactionPaletteOpen(): boolean {
  return !dom.reactionPalette.hidden
}

const GUIDE_SECTIONS: { title: MessageKey; items: MessageKey[] }[] = [
  {
    title: 'guide.sectionBasics',
    items: ['guide.basicNote', 'guide.basicText', 'guide.basicImage', 'guide.basicPen', 'guide.penFeel', 'guide.basicMove', 'guide.basicFormat'],
  },
  {
    title: 'guide.sectionPin',
    items: ['guide.pinSelect', 'guide.pinShortcut', 'guide.pinSidebar', 'guide.pinRule'],
  },
  {
    title: 'guide.sectionCanvas',
    items: ['guide.canvasPan', 'guide.canvasZoom', 'guide.canvasMinimap', 'guide.canvasEmpty', 'guide.canvasLasso', 'guide.canvasGroup'],
  },
  {
    title: 'guide.sectionCollab',
    items: ['guide.collabInvite', 'guide.collabFollow', 'guide.collabLaser', 'guide.collabReaction'],
  },
  {
    title: 'guide.sectionKeys',
    items: ['guide.keysUndo', 'guide.keysEdit', 'guide.keysClipboard', 'guide.keysGroup', 'guide.keysDelete', 'guide.keysEscape'],
  },
]

export function buildGuide(): void {
  dom.guideSections.innerHTML = GUIDE_SECTIONS.map(
    (section) => `
      <section class="guide-section">
        <h3>${t(section.title)}</h3>
        <ul>${section.items.map((item) => `<li class="guide-item">${t(item)}</li>`).join('')}</ul>
      </section>`,
  ).join('')
}

export function setGuideVisible(visible: boolean): void {
  dom.guideModal.hidden = !visible
  dom.btnGuide.setAttribute('aria-expanded', String(visible))
  if (visible) {
    buildGuide()
    setTimeout(() => dom.btnCloseGuide.focus(), 30)
  }
}

export function isGuideOpen(): boolean {
  return !dom.guideModal.hidden
}

export function syncSettings(values: { doubleClickEdit: boolean; minimapVisible: boolean }): void {
  dom.optDoubleClick.checked = values.doubleClickEdit
  dom.optMinimap.checked = values.minimapVisible
}

export function setSettingsVisible(visible: boolean): void {
  dom.settingsModal.hidden = !visible
  if (visible) setTimeout(() => dom.btnCloseSettings.focus(), 30)
}

export function isSettingsOpen(): boolean {
  return !dom.settingsModal.hidden
}

export function positionDropdown(): void {
  const rect = dom.btnMenu.getBoundingClientRect()
  const menu = dom.menu
  menu.hidden = false
  const w = menu.offsetWidth || 210
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, rect.right - w))}px`
  menu.style.top = `${rect.bottom + 8}px`
}

export function toggleMenu(): boolean {
  if (dom.menu.hidden) {
    positionDropdown()
    return true
  }
  dom.menu.hidden = true
  return false
}

export function hideMenu(): void {
  dom.menu.hidden = true
}

export function setRoomTitle(title: string): void {
  if (document.activeElement === dom.roomTitle) return
  dom.roomTitle.value = title
}

export function renderAvatars(
  self: PeerUser | null,
  peers: PeerUser[],
  followingId: string | null,
  onFollow: (userId: string) => void,
): void {
  dom.avatars.innerHTML = ''
  const all = [...peers]
  if (self) all.push(self)
  const visible = all.slice(0, 5)
  for (const user of visible) {
    const isSelf = self?.id === user.id
    const isFollowing = !isSelf && followingId === user.id
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `avatar${isSelf ? ' me' : ''}${isFollowing ? ' following' : ''}`
    button.style.background = user.color
    button.title = isSelf ? t('avatar.self', { name: user.name }) : t('avatar.follow', { name: user.name })
    button.setAttribute('aria-label', isSelf ? t('avatar.self', { name: user.name }) : t('avatar.follow', { name: user.name }))
    button.textContent = initials(user.name)
    const dot = document.createElement('span')
    dot.className = 'dot'
    button.appendChild(dot)
    if (!isSelf) {
      button.addEventListener('click', () => onFollow(user.id))
    }
    dom.avatars.appendChild(button)
  }
  if (all.length > 5) {
    const more = document.createElement('div')
    more.className = 'avatar more'
    more.textContent = `+${all.length - 5}`
    more.title = t('avatar.more', { n: all.length })
    dom.avatars.appendChild(more)
  }
}

export function showFollowBanner(user: PeerUser | null): void {
  dom.followBanner.hidden = !user
  if (!user) return
  dom.followName.textContent = user.name
  dom.followAvatar.textContent = initials(user.name)
  dom.followAvatar.style.background = user.color
}

export function setDropOverlay(show: boolean): void {
  dom.dropOverlay.hidden = !show
}

export type NameModalMode = 'join' | 'share'

export function configureNameModal(mode: NameModalMode): void {
  const share = mode === 'share'
  dom.nameModalTitle.textContent = t(share ? 'name.shareTitle' : 'name.title')
  dom.nameModalSubtitle.textContent = t(share ? 'name.shareSubtitle' : 'name.subtitle')
  dom.nameSubmit.textContent = t(share ? 'name.shareSubmit' : 'name.submit')
  dom.nameNote.textContent = t(share ? 'name.shareNote' : 'name.note')
  dom.btnCloseName.hidden = !share
  dom.btnCloseName.title = t('name.close')
  dom.btnCloseName.setAttribute('aria-label', t('name.close'))
}

export function setNameModalVisible(visible: boolean): void {
  dom.nameModal.hidden = !visible
  if (visible) {
    setTimeout(() => {
      dom.nameInput.focus()
      dom.nameInput.select()
    }, 30)
  }
}

export function isNameModalVisible(): boolean {
  return !dom.nameModal.hidden
}

export function setRoomId(roomId: string): void {
  dom.joinRoomId.textContent = roomId
}

export function setTitleEditableValue(value: string): void {
  dom.roomTitle.value = value
}

const noteIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v11l-5 5H4z"/><path d="M20 15h-5v5"/></svg>`
const textIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h14M12 5v14M8.5 19h7"/></svg>`
const imageIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.6"/><path d="M21 16l-5-5-6 6-3-2-4 4"/></svg>`
const penIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4L8 20l-5 1 1-5z"/><path d="M14 6l4 4"/></svg>`
const locateIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>`
const pinOffIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6l-1.2 5 2.8 2.8H7.4L10.2 8 9 3Z"/><path d="M12 10.8V21M4 4l16 16"/></svg>`

export const icons = { noteIcon, textIcon, imageIcon, penIcon, locateIcon, pinOffIcon }

window.addEventListener('pointerdown', (event) => {
  const target = event.target as HTMLElement
  if (!dom.ctxMenu.hidden && !dom.ctxMenu.contains(target)) hideContextMenu()
  if (!dom.menu.hidden && !dom.menu.contains(target) && !dom.btnMenu.contains(target)) hideMenu()
  if (!dom.reactionPalette.hidden && !dom.reactionPalette.contains(target) && !dom.btnReactions.contains(target)) {
    hideReactionPalette()
  }
}, true)
