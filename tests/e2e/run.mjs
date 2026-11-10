import { chromium } from 'playwright-core'
import { mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = 'http://127.0.0.1:5173'
const room = 'e2e-' + randomBytes(12).toString('base64url')
await mkdir('tests/e2e/screenshots', { recursive: true })

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN' })
const pageA = await ctxA.newPage()
const errors = []
pageA.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
pageA.on('pageerror', (err) => errors.push(err.message))

async function shot(page, name) {
  await page.screenshot({ path: `tests/e2e/screenshots/${name}.png` })
}

async function appState(page) {
  return page.evaluate(() => {
    const a = window.__pinboard
    return {
      lang: document.documentElement.lang,
      name: a.presence.name,
      peers: a.presence.peerList.map((p) => p.user.name),
      items: a.board.visibleItems().map((i) => ({ id: i.id, type: i.type, pinned: i.pinned, x: i.x, y: i.y, text: i.type === 'note' ? i.text : undefined })),
      camera: a.camera,
      pinCount: document.getElementById('pinCount').textContent,
      conn: document.getElementById('connState').innerText.trim(),
      headerOverflow: document.querySelector('header').scrollWidth - document.querySelector('header').clientWidth,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
    }
  })
}

async function waitSynced(page) {
  await page.waitForFunction(() => {
    const text = document.getElementById('connState')?.innerText || ''
    return Boolean(window.__pinboard) && (text.includes('已同步') || text.includes('Synced'))
  }, null, { timeout: 15000 })
}

async function join(page, name) {
  await page.waitForSelector('#nameModal', { state: 'hidden' })
  if (!name) return
  await page.click('#btnShare')
  await page.waitForSelector('#nameModal:not([hidden])')
  await page.fill('#nameInput', name)
  await page.click('#nameForm button[type=submit]')
  await page.waitForSelector('#nameModal', { state: 'hidden' })
}

async function canvasPointFor(page, world) {
  return page.evaluate(({ x, y }) => {
    const a = window.__pinboard
    const c = document.getElementById('board')
    const rect = c.getBoundingClientRect()
    return {
      x: (x - a.camera.x) * a.camera.scale + rect.left,
      y: (y - a.camera.y) * a.camera.scale + rect.top,
    }
  }, world)
}

await pageA.goto(`${BASE}/r/${room}`, { waitUntil: 'domcontentloaded' })
await pageA.waitForFunction(() => window.__pinboard)
assert.equal(await pageA.locator('#nameModal').isVisible(), false, 'name prompt is hidden on normal entry')
assert.ok((await pageA.evaluate(() => window.__pinboard.presence.name)).startsWith('访客'))

// Nickname is only requested when sharing for the first time.
await pageA.click('#btnShare')
await pageA.waitForSelector('#nameModal:not([hidden])')
assert.ok((await pageA.locator('#nameModalTitle').innerText()).includes('分享昵称'))
await shot(pageA, '09-share-name-zh')
await pageA.click('#btnCloseName')
await pageA.waitForSelector('#nameModal', { state: 'hidden' })
assert.equal(await pageA.evaluate(() => Boolean(localStorage.getItem('pinboard-name'))), false)
await join(pageA, '阿测')
await waitSynced(pageA)
await pageA.waitForTimeout(700)
await pageA.click('#btnShare')
await pageA.waitForTimeout(300)
assert.equal(await pageA.locator('#nameModal').isVisible(), false, 'later shares copy without asking again')
assert.equal(await pageA.evaluate(() => localStorage.getItem('pinboard-name')), '阿测')
let s = await appState(pageA)
assert.equal(s.lang, 'zh-CN')
assert.equal(s.name, '阿测')
assert.equal(s.pinCount, '1', 'seed should have one pinned item')

// Create a note through the UI.
await pageA.click('[data-tool="note"]')
const canvasBox = await pageA.locator('#board').boundingBox()
const cx = canvasBox.x + canvasBox.width * 0.55
const cy = canvasBox.y + canvasBox.height * 0.55
await pageA.mouse.click(cx, cy)
await pageA.waitForSelector('#editor', { state: 'visible' })
await pageA.fill('#editor', '国际化测试便签')
await pageA.press('#editor', 'Escape')
await pageA.waitForTimeout(300)
const noteId = await pageA.evaluate(() => {
  const a = window.__pinboard
  return a.board.visibleItems().find((i) => i.type === 'note' && i.text === '国际化测试便签')?.id
})
assert.ok(noteId, 'note created')
await pageA.evaluate((id) => {
  window.__pinboard.setSelection([id])
  window.__pinboard.requestRender()
}, noteId)
await pageA.waitForSelector('#selectionBar:not([hidden])', { timeout: 3000 })
await shot(pageA, '11-note-selected')

// Pin via the selection toolbar.
await pageA.click('#selectionBar [data-sel-action="pin"]')
await pageA.waitForTimeout(250)
const pinned = await pageA.evaluate((id) => window.__pinboard.board.item(id)?.pinned, noteId)
assert.equal(pinned, true)
const note = await pageA.evaluate((id) => {
  const i = window.__pinboard.board.item(id)
  return { x: i.x, y: i.y }
}, noteId)
const dragPoint = await canvasPointFor(pageA, { x: note.x + 10, y: note.y + 10 })
await shot(pageA, '12-note-pinned')

// Attempt to drag the pinned note.
const before = await pageA.evaluate((id) => {
  const i = window.__pinboard.board.item(id)
  return { x: i.x, y: i.y }
}, noteId)
await pageA.mouse.move(dragPoint.x, dragPoint.y)
await pageA.mouse.down()
await pageA.mouse.move(dragPoint.x + 70, dragPoint.y + 40, { steps: 6 })
await pageA.mouse.up()
await pageA.waitForTimeout(200)
const after = await pageA.evaluate((id) => {
  const i = window.__pinboard.board.item(id)
  return { x: i.x, y: i.y }
}, noteId)
assert.deepEqual(before, after, 'pinned note should not move')

// Pinned panel.
await pageA.click('#btnPinPanel')
await pageA.waitForSelector('#pinnedPanel:not([hidden])')
await pageA.waitForTimeout(250)
await shot(pageA, '13-pinned-panel')
const panelRows = await pageA.locator('#pinList .pin-item').count()
assert.ok(panelRows >= 2, 'pinned panel contains rows')
await pageA.click('#btnClosePanel')

// Upload an image.
await pageA.setInputFiles('#fileInput', 'tests/e2e/screenshots/13-pinned-panel.png')
await pageA.waitForFunction(() => window.__pinboard.board.visibleItems().some((i) => i.type === 'image'), null, { timeout: 15000 })
await pageA.waitForTimeout(500)
const image = await pageA.evaluate(() => {
  const img = window.__pinboard.board.visibleItems().find((i) => i.type === 'image')
  return { id: img?.id, assetId: img?.assetId }
})
assert.ok(image.id && image.assetId)
const assetStatus = await pageA.evaluate(async (assetId) => {
  const res = await fetch(`/api/rooms/${window.__pinboard.roomId}/assets/${assetId}`)
  return res.status
}, image.assetId)
assert.equal(assetStatus, 200, 'image asset is available')
await pageA.evaluate((id) => {
  window.__pinboard.setSelection([id])
  window.__pinboard.requestRender()
}, image.id)
await pageA.waitForTimeout(200)
await pageA.click('#selectionBar [data-sel-action="pin"]')
await pageA.waitForTimeout(250)
await shot(pageA, '14-image-pinned')

// Language switch and layout checks.
async function switchLanguage(page, lang) {
  await page.click('#btnMenu')
  await page.click(`[data-lang="${lang}"]`)
  await page.waitForTimeout(250)
}

await switchLanguage(pageA, 'en')
const enState = await appState(pageA)
assert.equal(enState.lang, 'en')
assert.equal(enState.headerOverflow, 0)
assert.equal(enState.pageOverflow, 0)
await shot(pageA, '15-english')
await pageA.click('#btnPinPanel')
await pageA.waitForTimeout(250)
await shot(pageA, '16-english-pinned')
await pageA.click('#btnClosePanel')
await switchLanguage(pageA, 'zh-TW')
const twState = await appState(pageA)
assert.equal(twState.lang, 'zh-TW')
assert.equal(twState.headerOverflow, 0)
assert.equal(twState.pageOverflow, 0)
await shot(pageA, '17-traditional')
await switchLanguage(pageA, 'zh-CN')

// Second client.
const ctxB = await browser.newContext({ viewport: { width: 1100, height: 800 }, locale: 'en-US' })
const pageB = await ctxB.newPage()
pageB.on('pageerror', (err) => errors.push('B:' + err.message))
await pageB.goto(`${BASE}/r/${room}`, { waitUntil: 'domcontentloaded' })
await pageB.waitForFunction(() => window.__pinboard)
await join(pageB, 'Bob')
await waitSynced(pageB)
await pageB.waitForTimeout(800)
await pageA.waitForFunction(() => window.__pinboard.presence.peerList.length >= 1)
const peerCount = await pageA.evaluate(() => window.__pinboard.presence.peerList.length)
assert.equal(peerCount, 1)
const bHasItems = await pageB.evaluate(() => ({
  notes: window.__pinboard.board.visibleItems().filter((i) => i.type === 'note').length,
  images: window.__pinboard.board.visibleItems().filter((i) => i.type === 'image').length,
}))
assert.ok(bHasItems.notes >= 1 && bHasItems.images >= 1, 'B should see shared notes and image')
await shot(pageB, '18-second-client-english')
await shot(pageA, '19-two-clients-zh')

// Follow from A's avatar bar.
const bobAvatar = pageA.locator('#avatars .avatar[title*="Bob"]').first()
assert.ok(await bobAvatar.count(), 'Bob avatar is present')
await bobAvatar.click()
await pageA.waitForSelector('#followBanner:not([hidden])')
await pageA.waitForTimeout(500)
await shot(pageA, '20-following')
await pageA.keyboard.press('Escape')
await pageA.waitForSelector('#followBanner', { state: 'hidden' })

// Laser from B, observed by A.
await pageB.evaluate(() => window.__pinboard.fitAll(false))
await pageB.keyboard.down('l')
const bBox = await pageB.locator('#board').boundingBox()
await pageB.mouse.move(bBox.x + 300, bBox.y + 250)
for (let i = 0; i < 12; i++) {
  await pageB.mouse.move(bBox.x + 300 + i * 12, bBox.y + 250 + Math.sin(i / 2) * 30)
  await pageB.waitForTimeout(35)
}
await pageA.waitForFunction(() => {
  const a = window.__pinboard
  return a.presence.peerList.some((p) => Boolean(p.state.laser))
}, null, { timeout: 5000 })
const remoteLaserCount = await pageA.evaluate(() => window.__pinboard.scene().lasers.length)
assert.ok(remoteLaserCount > 0, 'A should render a remote laser')
await shot(pageA, '21-remote-laser')
await pageB.keyboard.up('l')

// Reaction from B, observed by A; the palette stays open and stacks up to ×99.
await pageB.mouse.move(bBox.x + 420, bBox.y + 320)
await pageB.keyboard.press('e')
await pageB.waitForSelector('#reactionPalette:not([hidden])')
await pageB.keyboard.press('1')
await pageB.keyboard.press('1')
await pageB.keyboard.press('1')
await pageA.waitForFunction(() => {
  const a = window.__pinboard
  const latest = a.reactions[a.reactions.length - 1]
  return latest && latest.count >= 3
}, null, { timeout: 5000 })
const remoteReaction = await pageA.evaluate(() => {
  const a = window.__pinboard
  const latest = a.reactions[a.reactions.length - 1]
  return { count: latest.count }
})
assert.equal(remoteReaction.count, 3)
const paletteOpenB = await pageB.evaluate(() => !document.getElementById('reactionPalette').hidden)
assert.equal(paletteOpenB, true, 'palette remains open for continuous selection')
const badge = await pageB.evaluate(() => document.querySelector('#reactionPalette .react-count:not([hidden])')?.textContent)
assert.equal(badge, '×3')
await shot(pageA, '22-remote-reaction')
await pageB.keyboard.press('Escape')
await pageB.waitForSelector('#reactionPalette', { state: 'hidden' })

// Text editing by B, observed by A.
await pageB.evaluate(() => {
  window.__pinboard.fitAll(false)
  window.__pinboard.setSelection([])
  window.__pinboard.requestRender()
})
await pageB.waitForTimeout(200)
const noteB = await pageB.evaluate((id) => {
  const i = window.__pinboard.board.item(id)
  return i ? { x: i.x, y: i.y, w: i.w, h: i.h } : null
}, noteId)
assert.ok(noteB)
const noteCenterB = await canvasPointFor(pageB, { x: noteB.x + noteB.w / 2, y: noteB.y + noteB.h / 2 })
await pageB.evaluate((id) => {
  const a = window.__pinboard
  a.setSelection([id])
  a.requestRender()
}, noteId)
await pageB.waitForSelector('#selectionBar:not([hidden])')
await pageB.click('#selectionBar [data-sel-action="edit"]')
await pageB.waitForSelector('#editor', { state: 'visible' })
await pageB.fill('#editor', '国际化测试便签 + Bob edit')
await pageB.press('#editor', 'Escape')
await pageA.waitForFunction((id) => window.__pinboard.board.item(id)?.text.includes('Bob edit'), noteId, { timeout: 5000 })
await pageA.waitForTimeout(300)
const noteTextA = await pageA.evaluate((id) => window.__pinboard.board.item(id)?.text, noteId)
assert.ok(noteTextA.includes('Bob edit'))

// Deleting a mixed selection skips pinned items and keeps them selected.
const disposableId = await pageA.evaluate((pinnedId) => {
  const a = window.__pinboard
  const id = a.board.createNote({ x: 880, y: 240, w: 120, h: 120 }, '#fdba74', 'Disposable')
  a.board.stopCapturing()
  a.setSelection([pinnedId, id])
  a.requestRender()
  return id
}, noteId)
await pageA.waitForSelector('#selectionBar:not([hidden])')
assert.equal(await pageA.locator('#selectionBar [data-sel-action="delete"]').isDisabled(), false)
await pageA.locator('#board').focus()
await pageA.keyboard.press('Delete')
await pageA.waitForTimeout(400)
const partialDelete = await pageA.evaluate(({ pinnedId, disposableId }) => {
  const a = window.__pinboard
  return {
    pinnedDeleted: a.board.item(pinnedId)?.deleted,
    disposableDeleted: a.board.item(disposableId)?.deleted,
    selection: [...a.selection],
    toast: document.querySelector('#toasts .toast:last-child')?.textContent || '',
  }
}, { pinnedId: noteId, disposableId })
assert.equal(partialDelete.pinnedDeleted, false, 'pinned item survives mixed deletion')
assert.equal(partialDelete.disposableDeleted, true, 'unpinned item is deleted')
assert.deepEqual(partialDelete.selection, [noteId], 'pinned item remains selected')
assert.ok(partialDelete.toast.includes('保留'), 'partial-delete toast explains pinned items were kept')

// Reload A: persistence.
await pageA.reload({ waitUntil: 'domcontentloaded' })
await pageA.waitForFunction(() => window.__pinboard)
await pageA.waitForFunction(() => {
  return window.__pinboard.board.visibleItems().some((i) => i.text === '国际化测试便签 + Bob edit')
}, null, { timeout: 15000 })
await pageA.waitForTimeout(800)
const reloaded = await pageA.evaluate((id) => {
  const a = window.__pinboard
  return {
    modalHidden: document.getElementById('nameModal').hidden,
    name: a.presence.name,
    lang: document.documentElement.lang,
    pinned: a.board.item(id)?.pinned,
    pinCount: document.getElementById('pinCount').textContent,
  }
}, noteId)
assert.equal(reloaded.modalHidden, true)
assert.equal(reloaded.name, '阿测')
assert.equal(reloaded.lang, 'zh-CN')
assert.equal(reloaded.pinned, true)
await shot(pageA, '23-reloaded')

if (errors.length) console.log('CONSOLE ERRORS', errors)
console.log('E2E PASSED', JSON.stringify({ room, reloaded }, null, 2))
await browser.close()
