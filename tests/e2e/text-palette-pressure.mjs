import { chromium } from 'playwright-core'
import { mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = 'http://127.0.0.1:5173'
const room = 'txt-' + randomBytes(12).toString('base64url')
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
async function setRange(selector, value) {
  await page.evaluate(({ selector, value }) => {
    const input = document.querySelector(selector)
    input.value = String(value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, { selector, value })
}
async function setColor(selector, value) {
  await page.evaluate(({ selector, value }) => {
    const input = document.querySelector(selector)
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, { selector, value })
}
async function items() {
  return page.evaluate(() => window.__pinboard.board.visibleItems())
}

await page.goto(`${BASE}/r/${room}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#nameModal', { state: 'hidden' })
await page.waitForFunction(() => window.__pinboard)
await page.waitForFunction(() => document.getElementById('connState').innerText.includes('Synced'), null, { timeout: 15000 })
await page.waitForTimeout(600)

// Text tool creates a transparent plain-text item with size/color choices.
await page.click('[data-tool="text"]')
await page.waitForSelector('#textOpts.show')
assert.equal(await page.locator('#noteSwatches .sw').count(), 12)
assert.equal(await page.locator('#textSwatches .sw').count(), 12)
assert.equal(await page.locator('#penSwatches .sw').count(), 12)
await page.click('[data-text-size="28"]')
await setColor('#textCustomColor', '#0f766e')
await page.mouse.click(760, 320)
await page.waitForSelector('#textEditor', { state: 'visible' })
await page.fill('#textEditor', 'Plain text box\nSecond line')
await page.waitForTimeout(250)
const beforeClose = await page.evaluate(() => {
  const item = window.__pinboard.board.visibleItems().find((entry) => entry.type === 'text')
  return item ? { id: item.id, h: item.h, fontSize: item.fontSize, color: item.color } : null
})
assert.ok(beforeClose)
assert.equal(beforeClose.fontSize, 28)
assert.equal(beforeClose.color, '#0f766e')
assert.ok(beforeClose.h > 62, 'text box auto-grows for multiple lines')
await page.press('#textEditor', 'Escape')
await page.waitForSelector('#textEditor', { state: 'hidden' })
await page.waitForTimeout(250)
let textItem = await page.evaluate((id) => window.__pinboard.board.item(id), beforeClose.id)
assert.equal(textItem.type, 'text')
assert.equal(textItem.text, 'Plain text box\nSecond line')
await shot('110-text-box')

// Text boxes reuse the selection bar and Enter editing flow.
await page.evaluate((id) => {
  window.__pinboard.setSelection([id])
  window.__pinboard.requestRender()
}, textItem.id)
await page.waitForSelector('#selectionBar:not([hidden])')
assert.equal(await page.locator('#selectionBar [data-sel-action="edit"]').isVisible(), true)
assert.ok((await page.locator('#selectionBar [data-sel-action="edit"]').getAttribute('title')).includes('text'))
await page.locator('#board').focus()
await page.keyboard.press('Enter')
await page.waitForSelector('#textEditor', { state: 'visible' })
await page.press('#textEditor', 'End')
await page.keyboard.type(' updated')
await page.press('#textEditor', 'Escape')
await page.waitForTimeout(250)
textItem = await page.evaluate((id) => window.__pinboard.board.item(id), textItem.id)
assert.ok(textItem.text.endsWith('updated'))

// Custom note colors are supported and remain readable.
await page.click('[data-tool="note"]')
await page.waitForSelector('#noteOpts.show')
await setColor('#noteCustomColor', '#1f2937')
await page.mouse.click(980, 330)
await page.waitForSelector('#editor', { state: 'visible' })
await page.fill('#editor', 'Dark note')
await page.press('#editor', 'Escape')
await page.waitForTimeout(250)
const darkNote = (await items()).find((item) => item.type === 'note' && item.text === 'Dark note')
assert.ok(darkNote)
assert.equal(darkNote.color, '#1f2937')
await shot('111-custom-note-color')

// Pressure strength is adjustable and recorded with the stroke.
await page.click('[data-tool="pen"]')
await page.waitForSelector('#penOpts.show')
assert.equal(await page.locator('#penPressureControl').isVisible(), true)
await setRange('#penPressure', 100)
assert.equal(await page.locator('#penPressureLabel').innerText(), '100%')
await page.click('[data-pen-style="marker"]')
assert.equal(await page.locator('#penPressureControl').isVisible(), false)
await page.click('[data-pen-style="pen"]')
assert.equal(await page.locator('#penPressureControl').isVisible(), true)

const cdp = await context.newCDPSession(page)
const start = { x: 620, y: 640 }
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, button: 'none', buttons: 0, pointerType: 'pen', force: 0.1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.1 })
for (let i = 1; i <= 14; i++) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: start.x + i * 12,
    y: start.y + Math.sin(i / 2) * 32,
    button: 'left',
    buttons: 1,
    pointerType: 'pen',
    force: 0.08 + (i / 14) * 0.9,
  })
  await page.waitForTimeout(12)
}
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x + 168, y: start.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0.1 })
await page.waitForTimeout(300)
const pressureStroke = (await items()).filter((item) => item.type === 'stroke').at(-1)
assert.equal(pressureStroke.pressureSensitivity, 1)
assert.ok(pressureStroke.points.some((point) => typeof point.pressure === 'number'))

// Many selected objects share one outline; a group shows only the group outline.
await page.evaluate(() => {
  const app = window.__pinboard
  const a = app.board.createNote({ x: 120, y: 640, w: 120, h: 100 }, '#fde68a', 'A')
  const b = app.board.createNote({ x: 280, y: 640, w: 120, h: 100 }, '#bfdbfe', 'B')
  const c = app.board.createNote({ x: 440, y: 640, w: 120, h: 100 }, '#a7f3d0', 'C')
  app.board.stopCapturing()
  app.setTool('select')
  app.fitAll(true)
  app.setSelection([a, b, c])
  app.requestRender()
})
await page.waitForTimeout(400)
await shot('112-multi-selection-outline')
await page.locator('#board').focus()
await page.keyboard.press('Control+g')
await page.waitForTimeout(300)
const grouped = await page.evaluate(() => {
  const app = window.__pinboard
  const ids = [...app.selection]
  const groups = ids.map((id) => app.board.item(id)?.groupId)
  return { groups, selection: ids }
})
assert.equal(grouped.groups.length, 3)
assert.ok(grouped.groups.every((groupId) => groupId && groupId === grouped.groups[0]))
await shot('113-group-outline-only')

if (errors.length) console.log('CONSOLE ERRORS', errors)
console.log('TEXT PALETTE PRESSURE PASSED', JSON.stringify({ room, textId: textItem.id, darkNote: darkNote.id, pressure: pressureStroke.pairs ?? pressureStroke.points.length }))
await browser.close()
