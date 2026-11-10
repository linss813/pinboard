import { chromium } from 'playwright-core'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = 'http://127.0.0.1:5173'
const room = 'off-' + randomBytes(12).toString('base64url')
const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const ca = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN' })
const cb = await browser.newContext({ viewport: { width: 1024, height: 760 }, locale: 'en-US' })
const a = await ca.newPage(); const b = await cb.newPage()
a.on('pageerror', e => console.log('A ERR', e.message)); b.on('pageerror', e => console.log('B ERR', e.message))
async function join(page) {
  await page.waitForSelector('#nameModal', { state: 'hidden' })
  await page.waitForFunction(() => Boolean(window.__pinboard))
}
await a.goto(`${BASE}/r/${room}`, { waitUntil: 'domcontentloaded' })
await b.goto(`${BASE}/r/${room}`, { waitUntil: 'domcontentloaded' })
await a.waitForFunction(() => window.__pinboard)
await b.waitForFunction(() => window.__pinboard)
await join(a)
await join(b)
await a.waitForTimeout(800)
await a.waitForFunction(() => window.__pinboard.presence.peerList.length === 1)
await b.waitForFunction(() => window.__pinboard.presence.peerList.length === 1)

// Select an unpinned note to inspect the ghost pin visual.
await a.evaluate(() => {
  const p = window.__pinboard
  p.fitAll(false)
  p.setSelection(['seed-welcome'])
  p.requestRender()
})
await a.waitForTimeout(300)
await a.screenshot({ path: 'tests/e2e/screenshots/50-ghost-pin.png' })
await a.press('#board', 'e')
await a.waitForSelector('#reactionPalette:not([hidden])')
await a.screenshot({ path: 'tests/e2e/screenshots/51-reaction-palette.png' })
await a.keyboard.press('Escape')
await a.evaluate(() => {
  const p = window.__pinboard
  p.setSelection(['seed-welcome'])
  p.requestRender()
})
const note = await a.evaluate(() => { const i = window.__pinboard.board.item('seed-welcome'); return {x:i.x,y:i.y,w:i.w,h:i.h} })
const center = await a.evaluate(({x,y}) => { const p = window.__pinboard; const r=document.getElementById('board').getBoundingClientRect(); return {x:(x-p.camera.x)*p.camera.scale+r.left,y:(y-p.camera.y)*p.camera.scale+r.top} }, {x:note.x+note.w/2,y:note.y+note.h/2})
await a.mouse.click(center.x, center.y)
await a.waitForSelector('#selectionBar:not([hidden])')
await a.keyboard.press('Enter')
await a.waitForSelector('#editor', { state: 'visible' })
await a.screenshot({ path: 'tests/e2e/screenshots/52-editor.png' })
await a.press('#editor', 'Escape')

// B goes offline and creates a note.
await cb.setOffline(true)
await b.waitForTimeout(600)
const offlineLabel = await b.evaluate(() => document.getElementById('connState').innerText.trim())
await b.click('[data-tool="note"]')
const bb = await b.locator('#board').boundingBox()
await b.mouse.click(bb.x + bb.width * 0.6, bb.y + bb.height * 0.65)
await b.waitForSelector('#editor', { state: 'visible' })
await b.fill('#editor', '离线新增的便签')
await b.press('#editor', 'Escape')
await b.waitForTimeout(400)
const localHas = await b.evaluate(() => window.__pinboard.board.visibleItems().some(i => i.text === '离线新增的便签'))
assert.equal(localHas, true)
const remoteHasBefore = await a.evaluate(() => window.__pinboard.board.visibleItems().some(i => i.text === '离线新增的便签'))
assert.equal(remoteHasBefore, false)

await cb.setOffline(false)
await b.waitForFunction(() => {
  const t = document.getElementById('connState').innerText
  return t.includes('Synced') || t.includes('已同步') || t.includes('Connected') || t.includes('已连接')
}, null, { timeout: 20000 })
await a.waitForFunction(() => window.__pinboard.board.visibleItems().some(i => i.text === '离线新增的便签'), null, { timeout: 20000 })
const merged = await a.evaluate(() => window.__pinboard.board.visibleItems().find(i => i.text === '离线新增的便签')?.text)
assert.equal(merged, '离线新增的便签')
console.log('OFFLINE PASSED', { offlineLabel, merged })
await browser.close()
