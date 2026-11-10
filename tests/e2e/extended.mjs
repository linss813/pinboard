import { chromium } from 'playwright-core'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = 'http://127.0.0.1:5173'
const room = 'ext-' + randomBytes(12).toString('base64url')
const shots = 'tests/e2e/screenshots'
await mkdir(shots, { recursive: true })

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
const page = await context.newPage()
const errors = []
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
page.on('pageerror', (err) => errors.push(err.message))

async function shot(name) {
  await page.screenshot({ path: `${shots}/${name}.png` })
}
async function canvasPoint(world) {
  return page.evaluate(({ x, y }) => {
    const a = window.__pinboard
    const rect = document.getElementById('board').getBoundingClientRect()
    return {
      x: (x - a.camera.x) * a.camera.scale + rect.left,
      y: (y - a.camera.y) * a.camera.scale + rect.top,
    }
  }, world)
}
async function waitSynced() {
  await page.waitForFunction(() => {
    const text = document.getElementById('connState')?.innerText || ''
    return Boolean(window.__pinboard) && (text.includes('Synced') || text.includes('已同步'))
  }, null, { timeout: 15000 })
}
async function boardState() {
  return page.evaluate(() => ({
    items: window.__pinboard.board.visibleItems().map((i) => ({
      id: i.id,
      type: i.type,
      pinned: i.pinned,
      x: i.x,
      y: i.y,
      w: i.w,
      h: i.h,
      text: i.type === 'note' ? i.text : undefined,
    })),
    selection: [...window.__pinboard.selection],
    camera: window.__pinboard.camera,
    peers: window.__pinboard.presence.peerList.length,
    pinCount: document.getElementById('pinCount').textContent,
  }))
}
async function openMenu() {
  await page.click('#btnMenu')
  await page.waitForSelector('#menu:not([hidden])')
}

await page.goto(`${BASE}/r/${room}`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__pinboard)
await page.waitForSelector('#nameModal', { state: 'hidden' })
await waitSynced()
await page.waitForTimeout(800)
await shot('30-english-seed-1440')

// Layout checks at desktop width, including visible action labels.
const layout = await page.evaluate(() => {
  const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect()
  const header = document.querySelector('header')
  return {
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
    headerOverflow: header.scrollWidth - header.clientWidth,
    toolbarRight: rect('#toolbar')?.right,
    actionsLeft: rect('.head-actions')?.left,
    actionsRight: rect('.head-actions')?.right,
    zoomLeft: rect('.zoombox')?.left,
    avatarsLeft: rect('#avatars')?.left,
    menuLeft: rect('#btnMenu')?.left,
    inviteVisible: document.getElementById('btnShare').innerText.trim(),
    brand: document.querySelector('.brand b')?.innerText,
    seedTexts: window.__pinboard.board.visibleItems().filter((i) => i.type === 'note').map((i) => i.text),
  }
})
assert.equal(layout.pageOverflow, 0)
assert.equal(layout.headerOverflow, 0)
assert.ok(layout.actionsLeft > layout.toolbarRight)
assert.ok(layout.zoomLeft >= layout.actionsRight - 1)
assert.equal(layout.inviteVisible, 'Invite')
assert.equal(layout.brand, 'Whiteboard')

// Language menu.
await openMenu()
await shot('31-english-menu')
const menuCheck = await page.evaluate(() => {
  const menu = document.getElementById('menu')
  const rect = menu.getBoundingClientRect()
  return {
    width: rect.width,
    height: rect.height,
    overflow: menu.scrollHeight - menu.clientHeight,
    active: document.querySelector('[data-lang].active')?.dataset.lang,
    fits: rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth,
  }
})
assert.equal(menuCheck.active, 'en')
assert.equal(menuCheck.overflow, 0)
assert.equal(menuCheck.fits, true)
await page.keyboard.press('Escape')

// Pinned panel empty state.
await page.click('#btnPinPanel')
await page.waitForSelector('#pinnedPanel:not([hidden])')
await page.waitForTimeout(200)
await shot('32-english-pinned-empty')
const emptyText = await page.evaluate(() => ({
  title: document.querySelector('#pinEmpty b')?.textContent,
  body: document.querySelector('#pinEmpty p')?.textContent,
  search: document.getElementById('pinSearch').placeholder,
}))
assert.equal(emptyText.title, 'Nothing pinned yet')
await page.click('#btnClosePanel')

// Context menu.
let state = await boardState()
const welcome = state.items.find((i) => i.id === 'seed-welcome')
assert.ok(welcome)
const welcomeCenter = await canvasPoint({ x: welcome.x + welcome.w / 2, y: welcome.y + welcome.h / 2 })
await page.mouse.click(welcomeCenter.x, welcomeCenter.y, { button: 'right' })
await page.waitForSelector('#ctxMenu:not([hidden])')
await shot('33-english-context-menu')
const contextLabels = await page.locator('#ctxMenu button').allInnerTexts()
assert.ok(contextLabels.some((t) => t.includes('Duplicate')))
assert.ok(contextLabels.some((t) => t.includes('Bring to front')))
await page.keyboard.press('Escape')

// Long English content in a note.
await page.evaluate(() => {
  const a = window.__pinboard
  a.setSelection(['seed-welcome'])
  a.requestRender()
})
await page.waitForSelector('#selectionBar:not([hidden])')
await page.click('#selectionBar [data-sel-action="edit"]')
await page.waitForSelector('#editor', { state: 'visible' })
const longText = 'Welcome to the collaborative whiteboard. Select a note and press Enter to edit it, drag pinned items never move, and use the top pin to lock important decisions in place.'
await page.fill('#editor', longText)
await page.press('#editor', 'Escape')
await page.waitForTimeout(300)
await shot('34-english-long-note')
const edited = (await boardState()).items.find((i) => i.id === 'seed-welcome')
assert.equal(edited?.text, longText)

// Resize the selected note using the south-east handle.
await page.evaluate((id) => { window.__pinboard.setSelection([id]); window.__pinboard.requestRender() }, 'seed-welcome')
await page.waitForTimeout(200)
let note = (await boardState()).items.find((i) => i.id === 'seed-welcome')
const se = await canvasPoint({ x: note.x + note.w, y: note.y + note.h })
await page.mouse.move(se.x, se.y)
await page.mouse.down()
await page.mouse.move(se.x + 80, se.y + 60, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(250)
const resized = (await boardState()).items.find((i) => i.id === 'seed-welcome')
assert.ok(resized.w > note.w && resized.h > note.h, 'note resized')

// Marquee select (empty top-left to lower-right of notes).
await page.mouse.click(30, 120)
await page.evaluate(() => window.__pinboard.setSelection([]))
const bounds = await page.evaluate(() => {
  const a = window.__pinboard
  const items = a.board.visibleItems().filter((i) => typeof i.x === 'number' && typeof i.w === 'number')
  return items.reduce((acc, i) => ({
    minX: Math.min(acc.minX, i.x),
    minY: Math.min(acc.minY, i.y),
    maxX: Math.max(acc.maxX, i.x + i.w),
    maxY: Math.max(acc.maxY, i.y + i.h),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
})
const start = await canvasPoint({ x: bounds.minX - 60, y: bounds.minY - 60 })
const end = await canvasPoint({ x: bounds.maxX + 20, y: bounds.maxY + 20 })
const clamped = await page.evaluate(({ start, end }) => {
  const r = document.getElementById('board').getBoundingClientRect()
  const clamp = (x, min, max) => Math.max(min, Math.min(max, x))
  return {
    start: { x: clamp(start.x, r.left + 5, r.right - 5), y: clamp(start.y, r.top + 5, r.bottom - 5) },
    end: { x: clamp(end.x, r.left + 5, r.right - 5), y: clamp(end.y, r.top + 5, r.bottom - 5) },
  }
}, { start, end })
await page.mouse.move(clamped.start.x, clamped.start.y)
await page.mouse.down()
await page.mouse.move(clamped.end.x, clamped.end.y, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(250)
const marqueeSelection = await page.evaluate(() => [...window.__pinboard.selection])
assert.ok(marqueeSelection.length >= 2, 'marquee selects multiple items')

// Copy / paste keyboard flow.
await page.evaluate(() => { window.__pinboard.setSelection(['seed-welcome']); window.__pinboard.requestRender() })
await page.keyboard.press('Control+c')
await page.keyboard.press('Control+v')
await page.waitForTimeout(300)
const afterPaste = await boardState()
assert.ok(afterPaste.items.filter((i) => i.type === 'note').length >= 4)
await page.keyboard.press('Control+z')

// Connector from one note to another.
await page.click('[data-tool="connect"]')
const laserNote = afterPaste.items.find((i) => i.id === 'seed-laser')
const aPoint = await canvasPoint({ x: welcome.x + welcome.w / 2, y: welcome.y + welcome.h / 2 })
const bPoint = await canvasPoint({ x: laserNote.x + laserNote.w / 2, y: laserNote.y + laserNote.h / 2 })
await page.mouse.move(aPoint.x, aPoint.y)
await page.mouse.down()
await page.mouse.move(bPoint.x, bPoint.y, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(300)
const connectorCount = (await boardState()).items.filter((i) => i.type === 'connector').length
assert.ok(connectorCount >= 2, 'connector created')

// Pen stroke.
await page.click('[data-tool="pen"]')
await page.mouse.move(300, 150)
await page.mouse.down()
await page.mouse.move(380, 200, { steps: 10 })
await page.mouse.move(460, 160, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(300)
const strokeCount = (await boardState()).items.filter((i) => i.type === 'stroke').length
assert.equal(strokeCount, 1)
await shot('35-english-drawing')
await page.keyboard.press('Control+z')
await page.click('[data-tool="select"]')

// Pin-panel search and unpin.
await page.click('#btnPinPanel')
await page.waitForSelector('#pinnedPanel:not([hidden])')
await page.fill('#pinSearch', 'matters')
await page.waitForTimeout(200)
const filteredRows = await page.locator('#pinList .pin-item').count()
assert.equal(filteredRows, 1)
await page.fill('#pinSearch', '')
await page.locator('#pinList .pin-item').first().hover()
await page.waitForTimeout(150)
await shot('36-english-panel-filled')
const rowCount = await page.locator('#pinList .pin-item').count()
assert.ok(rowCount >= 1)
await page.locator('#pinList .pin-item').first().locator('.pin-actions button').nth(1).click()
await page.waitForTimeout(250)
const countAfterUnpin = await page.evaluate(() => document.getElementById('pinCount').textContent)
assert.equal(countAfterUnpin, '0')
await page.click('#btnClosePanel')

// Exports and import.
async function downloadViaMenu(action, filename) {
  await openMenu()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click(`[data-menu-action="${action}"]`),
  ])
  const path = `${shots}/${filename}`
  await download.saveAs(path)
  return path
}
const jsonPath = await downloadViaMenu('export-json', 'exported-board.json')
const pngPath = await downloadViaMenu('export-png', 'exported-board.png')
const json = JSON.parse(await readFile(jsonPath, 'utf8'))
assert.equal(json.format, 'pinboard')
assert.ok(Array.isArray(json.items) && json.items.length > 0)
const pngStat = await stat(pngPath)
assert.ok(pngStat.size > 100)
const beforeImport = (await boardState()).items.length
await page.setInputFiles('#jsonInput', jsonPath)
await page.waitForTimeout(1200)
const afterImport = (await boardState()).items.length
assert.ok(afterImport > beforeImport, 'JSON import merges items')

// Switching to Traditional Chinese at desktop width.
await openMenu()
await page.click('[data-lang="zh-TW"]')
await page.waitForTimeout(250)
const tw = await page.evaluate(() => ({
  lang: document.documentElement.lang,
  brand: document.querySelector('.brand b')?.textContent,
  overflow: document.documentElement.scrollWidth - innerWidth,
  header: document.querySelector('header').scrollWidth - document.querySelector('header').clientWidth,
  invite: document.getElementById('btnShare').innerText.trim(),
}))
assert.equal(tw.lang, 'zh-TW')
assert.equal(tw.brand, '協作白板')
assert.equal(tw.overflow, 0)
assert.equal(tw.header, 0)
await shot('37-traditional-1440')

// Narrow layout in English.
await openMenu()
await page.click('[data-lang="en"]')
await page.waitForTimeout(200)
await page.setViewportSize({ width: 1024, height: 720 })
await page.waitForTimeout(400)
await shot('38-english-1024')
const narrow = await page.evaluate(() => ({
  pageOverflow: document.documentElement.scrollWidth - innerWidth,
  headerOverflow: document.querySelector('header').scrollWidth - document.querySelector('header').clientWidth,
  barMax: document.getElementById('selectionBar').getBoundingClientRect().right,
}))
assert.equal(narrow.pageOverflow, 0)
assert.equal(narrow.headerOverflow, 0)

await page.setViewportSize({ width: 820, height: 680 })
await page.waitForTimeout(400)
await shot('39-english-820')
const narrow2 = await page.evaluate(() => ({
  pageOverflow: document.documentElement.scrollWidth - innerWidth,
  headerOverflow: document.querySelector('header').scrollWidth - document.querySelector('header').clientWidth,
}))
assert.equal(narrow2.pageOverflow, 0)
assert.equal(narrow2.headerOverflow, 0)

if (errors.length) console.log('CONSOLE ERRORS', errors)
console.log('EXTENDED PASSED', JSON.stringify({ room, items: afterImport, rowCount }, null, 2))
await browser.close()
