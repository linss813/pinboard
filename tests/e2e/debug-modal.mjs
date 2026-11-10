import { chromium } from 'playwright-core'
import { randomBytes } from 'node:crypto'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const room = 'dbgm-' + randomBytes(12).toString('base64url')
const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN' })
const page = await ctx.newPage()
await page.goto(`http://127.0.0.1:5173/r/${room}`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__pinboard)
await page.fill('#nameInput', 'Modal')
await page.click('#nameForm button[type=submit]')
await page.waitForSelector('#nameModal', { state: 'hidden' })
await page.waitForTimeout(700)
await page.click('#btnMenu')
await page.click('[data-menu-action="settings"]')
await page.waitForSelector('#settingsModal:not([hidden])')
await page.waitForTimeout(1000)
const info = await page.evaluate(() => {
  const visibles = [...document.querySelectorAll('.modal-backdrop, .settings-card, .guide-card, .join-card')].map(el => ({ tag: el.tagName, id: el.id, cls: el.className, hidden: el.hidden, display: getComputedStyle(el).display, rect: el.getBoundingClientRect().toJSON(), z: getComputedStyle(el).zIndex, opacity: getComputedStyle(el).opacity }))
  const stack = document.elementsFromPoint(700, 255).slice(0,5).map(el => ({tag: el.tagName, id: el.id, cls: el.className, bg: getComputedStyle(el).backgroundColor}))
  return { visibles, stack }
})
console.log(JSON.stringify(info, null, 2))
await page.screenshot({ path: 'tests/e2e/screenshots/debug-settings-stable.png', animations: 'disabled' })
await page.evaluate(() => { document.querySelector('.modal-backdrop').style.backdropFilter = 'none'; document.getElementById('settingsModal').style.backdropFilter='none' })
await page.screenshot({ path: 'tests/e2e/screenshots/debug-settings-noblur.png' })
await browser.close()
