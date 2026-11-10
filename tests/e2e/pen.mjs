import { chromium } from 'playwright-core'
import { mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = 'http://127.0.0.1:5173'
const room = 'pen-' + randomBytes(12).toString('base64url')
const shots = 'tests/e2e/screenshots'
await mkdir(shots, { recursive: true })

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US' })
const page = await context.newPage()
const errors = []
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
page.on('pageerror', (err) => errors.push(err.message))

async function shot(name) {
  await page.screenshot({ path: `${shots}/${name}.png` })
}

async function strokes() {
  return page.evaluate(() =>
    window.__pinboard.board
      .visibleItems()
      .filter((item) => item.type === 'stroke')
      .map((item) => ({
        id: item.id,
        color: item.color,
        width: item.width,
        style: item.style,
        points: item.points,
      })),
  )
}

async function draw(points) {
  await page.mouse.move(points[0].x, points[0].y)
  await page.mouse.down()
  for (let i = 1; i < points.length; i++) {
    await page.mouse.move(points[i].x, points[i].y, { steps: 8 })
  }
  await page.mouse.up()
  await page.waitForTimeout(250)
}

async function setWidth(value) {
  await page.evaluate((next) => {
    const input = document.getElementById('penWidth')
    input.value = String(next)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

async function setCustomColor(value) {
  await page.evaluate((next) => {
    const input = document.getElementById('penCustomColor')
    input.value = next
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

await page.goto(`${BASE}/r/${room}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#nameModal', { state: 'hidden' })
await page.waitForFunction(() => window.__pinboard)
await page.waitForFunction(() => document.getElementById('connState').innerText.includes('Synced'), null, { timeout: 15000 })
await page.waitForTimeout(600)

// Marker with custom color and a thicker width.
await page.click('[data-tool="pen"]')
await page.waitForSelector('#penOpts.show')
await shot('100-pen-options')
await page.click('[data-pen-style="marker"]')
await setCustomColor('#0f766e')
await setWidth(10)
await draw([{ x: 300, y: 610 }, { x: 410, y: 535 }, { x: 520, y: 620 }])
let list = await strokes()
const marker = list[list.length - 1]
assert.equal(marker.style, 'marker')
assert.equal(marker.color, '#0f766e')
assert.ok(Math.abs(marker.width - 14.5) < 0.01, `marker width ${marker.width}`)
assert.ok(marker.points.length > 10)

// Highlighter is wider, translucent and keeps a round cap.
await page.click('[data-pen-style="highlighter"]')
await setWidth(12)
await draw([{ x: 690, y: 610 }, { x: 820, y: 585 }, { x: 950, y: 615 }])
list = await strokes()
const highlighter = list[list.length - 1]
assert.equal(highlighter.style, 'highlighter')
assert.ok(Math.abs(highlighter.width - 32.4) < 0.01, `highlighter width ${highlighter.width}`)

// Mouse pen strokes keep clean round joins on right angles and smooth curves.
await page.click('[data-pen-style="pen"]')
await setWidth(7)
await draw([
  { x: 280, y: 745 },
  { x: 390, y: 745 },
  { x: 390, y: 675 },
  { x: 500, y: 675 },
])
await draw([
  { x: 600, y: 745 },
  { x: 650, y: 680 },
  { x: 710, y: 745 },
  { x: 770, y: 680 },
])
await shot('101-pen-mouse-corners')

// Stylus pressure through CDP produces pressure samples and tapered pen ink.
await page.click('[data-pen-style="pen"]')
await setWidth(7)
await page.click('[data-tool="pen"]')
const cdp = await context.newCDPSession(page)
const penStart = { x: 820, y: 400 }
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: penStart.x, y: penStart.y, button: 'none', buttons: 0, pointerType: 'pen', force: 0.15 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: penStart.x, y: penStart.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.15 })
for (let i = 1; i <= 12; i++) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: penStart.x + i * 10,
    y: penStart.y + Math.sin(i / 2) * 34,
    button: 'left',
    buttons: 1,
    pointerType: 'pen',
    force: 0.12 + (i / 12) * 0.85,
  })
  await page.waitForTimeout(12)
}
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: penStart.x + 120, y: penStart.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0.1 })
await page.waitForTimeout(300)
list = await strokes()
const pressureStroke = list[list.length - 1]
assert.equal(pressureStroke.style, 'pen')
const pressures = pressureStroke.points.map((point) => point.pressure).filter((value) => typeof value === 'number')
assert.ok(pressures.length >= 4, `pressure samples: ${pressures.length}`)
assert.ok(Math.max(...pressures) > Math.min(...pressures) + 0.3, 'stylus pressure varies')
await shot('101-pen-strokes')

// Eraser removes the marker stroke and undo restores it.
const markerId = marker.id
await page.keyboard.press('r')
await page.waitForTimeout(150)
assert.equal(await page.evaluate(() => window.__pinboard.tool), 'eraser')
await page.mouse.move(300, 610)
await page.mouse.move(410, 560)
await page.waitForTimeout(120)
await shot('102-eraser-cursor')
await page.mouse.down()
await page.mouse.move(410, 535, { steps: 12 })
await page.mouse.move(520, 620, { steps: 12 })
await page.mouse.up()
await page.waitForTimeout(350)
assert.equal(await page.evaluate((id) => window.__pinboard.board.item(id)?.deleted, markerId), true)
await page.keyboard.press('Control+z')
await page.waitForTimeout(300)
assert.equal(await page.evaluate((id) => window.__pinboard.board.item(id)?.deleted, markerId), false, 'undo restores erased stroke')
await shot('103-pen-undo')

// Pin the marker stroke and verify the eraser leaves it untouched.
await page.evaluate((id) => {
  window.__pinboard.board.togglePin([id])
  window.__pinboard.board.stopCapturing()
  window.__pinboard.requestRender()
}, markerId)
await page.mouse.down()
await page.mouse.move(520, 620, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(250)
assert.equal(await page.evaluate((id) => window.__pinboard.board.item(id)?.deleted, markerId), false, 'pinned strokes are protected from erasing')

if (errors.length) console.log('CONSOLE ERRORS', errors)
console.log('PEN PASSED', JSON.stringify({ room, styles: (await strokes()).map((stroke) => stroke.style), pressures: pressures.length }))
await browser.close()
