import { chromium } from 'playwright-core'
import { mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = 'http://127.0.0.1:5173'
const room = 'ux-' + randomBytes(12).toString('base64url')
const shots = 'tests/e2e/screenshots'
await mkdir(shots, { recursive: true })

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN' })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(`${BASE}/r/${room}`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__pinboard)
await page.waitForSelector('#nameModal', { state: 'hidden' })
await page.waitForFunction(() => document.getElementById('connState').innerText.includes('已同步'), null, { timeout: 15000 })
await page.waitForTimeout(700)
await page.screenshot({ path: `${shots}/70-guide-fab-and-minimap.png` })

// Keyboard shortcut opens and closes the guide.
await page.keyboard.press('Shift+Slash')
await page.waitForSelector('#guideModal:not([hidden])')
const guide = await page.evaluate(() => ({
  sections: document.querySelectorAll('#guideSections .guide-section').length,
  cardWidth: document.querySelector('.guide-card').getBoundingClientRect().width,
  overflowX: document.querySelector('.guide-card').scrollWidth - document.querySelector('.guide-card').clientWidth,
  title: document.getElementById('guideTitle').textContent,
}))
assert.equal(guide.sections, 5)
assert.equal(guide.overflowX, 0)
await page.waitForTimeout(260)
await page.screenshot({ path: `${shots}/71-guide-zh.png` })
await page.keyboard.press('Escape')
await page.waitForSelector('#guideModal', { state: 'hidden' })

// Long-press empty canvas opens reactions at that position and keeps the palette open.
const box = await page.locator('#board').boundingBox()
const lx = box.x + 60
const ly = box.y + 140
await page.mouse.move(lx, ly)
await page.mouse.down()
await page.waitForSelector('#reactionPalette:not([hidden])', { timeout: 2000 })
await page.mouse.up()
const longPressState = await page.evaluate(() => ({
  open: !document.getElementById('reactionPalette').hidden,
  anchor: window.__pinboard.reactionAnchor,
}))
assert.equal(longPressState.open, true)
assert.ok(longPressState.anchor)

const reactButton = page.locator('#reactionPalette .react').first()
await reactButton.click()
await page.waitForTimeout(40)
for (let i = 0; i < 4; i++) await reactButton.click()
await page.waitForTimeout(250)
const afterFive = await page.evaluate(() => {
  const a = window.__pinboard
  const latest = a.reactions[a.reactions.length - 1]
  return {
    open: !document.getElementById('reactionPalette').hidden,
    badge: document.querySelector('#reactionPalette .react-count:not([hidden])')?.textContent,
    count: latest?.count,
    reactions: a.reactions.length,
  }
})
assert.equal(afterFive.open, true, 'palette stays open')
assert.equal(afterFive.badge, '×5')
assert.equal(afterFive.count, 5)
await page.screenshot({ path: `${shots}/72-reaction-x5.png` })

// Keyboard selection continues the same burst and the cap is 99.
await page.keyboard.press('1')
await page.waitForTimeout(50)
await page.evaluate(() => {
  const btn = document.querySelector('#reactionPalette .react')
  for (let i = 0; i < 100; i++) btn.click()
})
await page.waitForTimeout(300)
const capped = await page.evaluate(() => {
  const a = window.__pinboard
  const latest = a.reactions[a.reactions.length - 1]
  return {
    badge: document.querySelector('#reactionPalette .react-count:not([hidden])')?.textContent,
    count: latest?.count,
    open: !document.getElementById('reactionPalette').hidden,
  }
})
assert.equal(capped.open, true)
assert.equal(capped.count, 99)
assert.equal(capped.badge, '×99')
await page.screenshot({ path: `${shots}/73-reaction-x99.png` })
await page.keyboard.press('Escape')
await page.waitForSelector('#reactionPalette', { state: 'hidden' })

// Alt-click opens the palette at a different point (even over content).
await page.keyboard.down('Alt')
await page.mouse.click(box.x + 420, box.y + 220)
await page.keyboard.up('Alt')
await page.waitForSelector('#reactionPalette:not([hidden])')
const altOpen = await page.evaluate(() => ({ open: !document.getElementById('reactionPalette').hidden, anchor: window.__pinboard.reactionAnchor }))
assert.equal(altOpen.open, true)
await page.keyboard.press('Escape')

// Guide in English, to verify text expansion and layout.
await page.click('#btnMenu')
await page.click('[data-lang="en"]')
await page.waitForTimeout(250)
await page.click('#btnGuide')
await page.waitForSelector('#guideModal:not([hidden])')
await page.waitForTimeout(200)
const guideEn = await page.evaluate(() => {
  const card = document.querySelector('.guide-card')
  return {
    sections: document.querySelectorAll('#guideSections .guide-section').length,
    overflowX: card.scrollWidth - card.clientWidth,
    overflowY: card.scrollHeight - card.clientHeight,
    title: document.getElementById('guideTitle').textContent,
  }
})
assert.equal(guideEn.sections, 5)
assert.equal(guideEn.overflowX, 0)
await page.screenshot({ path: `${shots}/74-guide-en.png` })
await page.keyboard.press('Escape')
await page.waitForSelector('#guideModal', { state: 'hidden' })

// Minimap hide / restore and M shortcut.
await page.click('#btnMinimapToggle')
await page.waitForTimeout(200)
assert.equal(await page.evaluate(() => document.getElementById('viewport').classList.contains('minimap-hidden')), true)
await page.screenshot({ path: `${shots}/75-minimap-hidden.png` })
await page.keyboard.press('m')
await page.waitForTimeout(300)
assert.equal(await page.evaluate(() => document.getElementById('viewport').classList.contains('minimap-hidden')), false)
await page.waitForTimeout(300)

// Drag sensitivity: minimap drag applies a reduced delta to the camera.
const dragInfo = await page.evaluate(() => {
  const a = window.__pinboard
  return {
    center: {
      x: a.camera.x + a.renderer.W / (2 * a.camera.scale),
      y: a.camera.y + a.renderer.H / (2 * a.camera.scale),
    },
    mmScale: a.renderer.minimapScale(),
    rect: document.getElementById('minimap').getBoundingClientRect().toJSON(),
  }
})
const beforeCenter = dragInfo.center
const mmRect = dragInfo.rect
assert.ok(dragInfo.mmScale > 0)
await page.mouse.move(mmRect.x + mmRect.width / 2, mmRect.y + mmRect.height / 2)
await page.mouse.down()
await page.mouse.move(mmRect.x + mmRect.width / 2 + 40, mmRect.y + mmRect.height / 2, { steps: 6 })
await page.mouse.up()
await page.waitForTimeout(250)
const afterCenter = await page.evaluate(() => {
  const a = window.__pinboard
  return { x: a.camera.x + a.renderer.W / (2 * a.camera.scale), y: a.camera.y + a.renderer.H / (2 * a.camera.scale) }
})
const expectedDx = (40 / dragInfo.mmScale) * 0.35
const actualDx = afterCenter.x - beforeCenter.x
assert.ok(Math.abs(actualDx - expectedDx) / expectedDx < 0.25, `minimap sensitivity ${actualDx} vs ${expectedDx}`)

// Persist hidden state across reload.
await page.click('#btnMinimapToggle')
await page.waitForTimeout(200)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__pinboard)
await page.waitForSelector('#nameModal', { state: 'hidden' })
await page.waitForFunction(() => document.getElementById('connState').innerText.includes('Synced'), null, { timeout: 15000 })
await page.waitForTimeout(500)
assert.equal(await page.evaluate(() => document.getElementById('viewport').classList.contains('minimap-hidden')), true)
await page.click('#btnMinimapShow')
await page.waitForTimeout(300)
await page.screenshot({ path: `${shots}/76-final-ux.png` })

if (errors.length) console.log('CONSOLE ERRORS', errors)
console.log('UX PASSED', { room, guide, guideEn, sensitivity: { expectedDx, actualDx } })
await browser.close()
