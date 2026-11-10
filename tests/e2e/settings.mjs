import { chromium } from 'playwright-core'
import { mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = 'http://127.0.0.1:5173'
const room = 'set-' + randomBytes(12).toString('base64url')
const shots = 'tests/e2e/screenshots'
await mkdir(shots, { recursive: true })

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN' })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

async function shot(name) {
  await page.screenshot({ path: `${shots}/${name}.png` })
}
async function join() {
  await page.goto(`${BASE}/r/${room}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__pinboard)
  await page.waitForSelector('#nameModal', { state: 'hidden' })
  await page.waitForFunction(() => {
    const t = document.getElementById('connState')?.innerText || ''
    return t.includes('已同步') || t.includes('Synced')
  }, null, { timeout: 15000 })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.waitForTimeout(500)
}
async function noteCenter() {
  return page.evaluate(() => {
    const a = window.__pinboard
    const note = a.board.item('seed-welcome')
    if (!note || note.type !== 'note') throw new Error('welcome note missing')
    const r = document.getElementById('board').getBoundingClientRect()
    return {
      x: (note.x + note.w / 2 - a.camera.x) * a.camera.scale + r.left,
      y: (note.y + note.h / 2 - a.camera.y) * a.camera.scale + r.top,
    }
  })
}
async function openSettings() {
  await page.click('#btnMenu')
  await page.click('[data-menu-action="settings"]')
  await page.waitForSelector('#settingsModal:not([hidden])')
  await page.waitForTimeout(150)
}
async function closeSettings() {
  await page.click('#btnCloseSettings')
  await page.waitForSelector('#settingsModal', { state: 'hidden' })
}
async function openMenu() {
  await page.click('#btnMenu')
  await page.waitForSelector('#menu:not([hidden])')
}
async function switchLanguage(lang) {
  await openMenu()
  await page.click(`[data-lang="${lang}"]`)
  await page.waitForTimeout(300)
}

await join()

// Default: double-click does not open the editor.
const center = await noteCenter()
await page.mouse.dblclick(center.x, center.y)
await page.waitForTimeout(180)
assert.equal(await page.locator('#editor').isVisible(), false, 'double-click editing is off by default')

// Explicit editing via selection toolbar and Enter still works.
await page.mouse.click(center.x, center.y)
await page.waitForSelector('#selectionBar:not([hidden])')
assert.equal(await page.locator('#selectionBar [data-sel-action="edit"]').isVisible(), true)
await page.click('#selectionBar [data-sel-action="edit"]')
await page.waitForSelector('#editor', { state: 'visible' })
await page.press('#editor', 'Escape')
await page.mouse.click(center.x, center.y)
await page.keyboard.press('Enter')
await page.waitForSelector('#editor', { state: 'visible' })
await page.press('#editor', 'Escape')

// Settings: inspect defaults and toggle interactions.
await openSettings()
assert.equal(await page.locator('#optDoubleClick').isChecked(), false)
assert.equal(await page.locator('#optMinimap').isChecked(), true)
await page.waitForTimeout(200)
await shot('80-settings-zh')
await page.locator('#optDoubleClick').check({ force: true })
await page.locator('#optMinimap').uncheck({ force: true })
await page.waitForTimeout(200)
assert.equal(await page.evaluate(() => document.getElementById('viewport').classList.contains('minimap-hidden')), true)
await page.locator('#optMinimap').check({ force: true })
await page.waitForTimeout(200)
assert.equal(await page.evaluate(() => document.getElementById('viewport').classList.contains('minimap-hidden')), false)
await closeSettings()

// With the setting enabled, double-click edits the note.
await page.mouse.dblclick(center.x, center.y)
await page.waitForSelector('#editor', { state: 'visible' })
await page.press('#editor', 'Escape')

// Font stack and loading for zh-CN.
const fontsZh = await page.evaluate(async () => {
  await document.fonts.load('14px "Inter Variable"')
  return {
    check: document.fonts.check('14px "Inter Variable"'),
    family: getComputedStyle(document.body).fontFamily,
  }
})
assert.equal(fontsZh.check, true)
assert.ok(fontsZh.family.includes('Inter Variable'))
assert.ok(/PingFang SC|Microsoft YaHei|Noto Sans SC/i.test(fontsZh.family))
await shot('81-board-zh-fonts')

// English and Traditional font stacks and settings layout.
await switchLanguage('en')
const fontsEn = await page.evaluate(() => ({ family: getComputedStyle(document.body).fontFamily }))
assert.ok(/Segoe UI|Inter Variable/i.test(fontsEn.family))
await openSettings()
await page.waitForTimeout(150)
const settingsEn = await page.evaluate(() => {
  const card = document.querySelector('.settings-card')
  return {
    overflowX: card.scrollWidth - card.clientWidth,
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
    title: document.getElementById('settingsTitle').textContent,
  }
})
assert.equal(settingsEn.overflowX, 0)
assert.equal(settingsEn.pageOverflow, 0)
await shot('82-settings-en')
await closeSettings()
await shot('83-board-en-fonts')

await switchLanguage('zh-TW')
const fontsTw = await page.evaluate(() => ({ family: getComputedStyle(document.body).fontFamily }))
assert.ok(/PingFang TC|Microsoft JhengHei|Noto Sans TC/i.test(fontsTw.family))
await openSettings()
await page.waitForTimeout(150)
const settingsTw = await page.evaluate(() => {
  const card = document.querySelector('.settings-card')
  return { overflowX: card.scrollWidth - card.clientWidth, pageOverflow: document.documentElement.scrollWidth - innerWidth }
})
assert.equal(settingsTw.overflowX, 0)
assert.equal(settingsTw.pageOverflow, 0)
await shot('84-settings-tw')
await closeSettings()
await shot('85-board-tw-fonts')

// The preference persists after a reload.
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__pinboard)
await page.waitForSelector('#nameModal', { state: 'hidden' })
await page.waitForFunction(() => document.getElementById('connState').innerText.includes('已同步'), null, { timeout: 15000 })
await page.waitForTimeout(600)
const centerReloaded = await noteCenter()
assert.equal(await page.evaluate(() => localStorage.getItem('pinboard-dbl-edit')), '1')
await page.mouse.dblclick(centerReloaded.x, centerReloaded.y)
await page.waitForSelector('#editor', { state: 'visible' })
await page.press('#editor', 'Escape')

// Turn it back off and verify persistence.
await openSettings()
await page.locator('#optDoubleClick').uncheck({ force: true })
await closeSettings()
await page.mouse.dblclick(centerReloaded.x, centerReloaded.y)
await page.waitForTimeout(180)
assert.equal(await page.locator('#editor').isVisible(), false)

if (errors.length) console.log('CONSOLE ERRORS', errors)
console.log('SETTINGS PASSED', { room, fontsZh: fontsZh.family, fontsEn: fontsEn.family, fontsTw: fontsTw.family, settingsEn, settingsTw })
await browser.close()
