import { chromium } from 'playwright-core'
import { mkdir, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = 'http://127.0.0.1:5173'
const room = 'rich-' + randomBytes(12).toString('base64url')
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

async function join(target) {
  await target.goto(`${BASE}/r/${room}`, { waitUntil: 'domcontentloaded' })
  await target.waitForFunction(() => window.__pinboard)
  await target.waitForSelector('#nameModal', { state: 'hidden' })
  await target.waitForFunction(() => {
    const text = document.getElementById('connState')?.innerText || ''
    return text.includes('Synced') || text.includes('已同步')
  }, null, { timeout: 15000 })
  await target.evaluate(() => document.fonts.ready.then(() => undefined))
  await target.waitForTimeout(500)
}

async function openEditor(id) {
  await page.evaluate((noteId) => {
    window.__pinboard.setSelection([noteId])
    window.__pinboard.requestRender()
  }, id)
  await page.waitForSelector('#selectionBar:not([hidden])')
  await page.click('#selectionBar [data-sel-action="edit"]')
  await page.waitForSelector('#editor', { state: 'visible' })
  await page.waitForSelector('#formatBar:not([hidden])')
}

async function noteState(id) {
  return page.evaluate((noteId) => {
    const note = window.__pinboard.board.item(noteId)
    if (!note || note.type !== 'note') return null
    return {
      text: note.text,
      lines: note.lines,
      x: note.x,
      y: note.y,
      groupId: note.groupId,
    }
  }, id)
}

async function canvasPoint(world) {
  return page.evaluate(({ x, y }) => {
    const app = window.__pinboard
    const rect = document.getElementById('board').getBoundingClientRect()
    return {
      x: (x - app.camera.x) * app.camera.scale + rect.left,
      y: (y - app.camera.y) * app.camera.scale + rect.top,
    }
  }, world)
}

await join(page)

// Rich text editor basics and toolbar.
await openEditor('seed-welcome')
await shot('90-editor-rich-toolbar')
await page.locator('#editor .note-line').first().click({ position: { x: 28, y: 8 } })
await page.click('[data-fmt="bold"]')
await page.click('[data-fmt="bullet"]')
await page.selectOption('#fmtSize', 'l')
await page.waitForTimeout(250)
let rich = await noteState('seed-welcome')
assert.equal(rich.lines[0].bold, true, 'bold applies to the active line')
assert.equal(rich.lines[0].list, 'bullet', 'bullet list applies')
assert.equal(rich.lines[0].size, 'l', 'font size applies')
assert.equal(await page.locator('#editor .note-line').first().evaluate((el) => getComputedStyle(el).fontWeight), '700')
assert.equal(await page.locator('#editor .note-line').first().getAttribute('data-list'), 'bullet')
await shot('91-editor-rich-formatted')

// Enter creates a new line; typing and numbered list stay local + collaborative.
await page.keyboard.press('Control+End')
await page.keyboard.press('Enter')
await page.keyboard.type('Second rich line')
await page.click('[data-fmt="ordered"]')
await page.click('[data-fmt="align-center"]')
await page.keyboard.press('Control+b')
await page.waitForTimeout(300)
rich = await noteState('seed-welcome')
const appendedIndex = rich.lines.findIndex((line) => line.text === 'Second rich line')
assert.ok(appendedIndex >= 0, 'Enter and typing created a new line')
assert.equal(rich.lines[appendedIndex].list, 'ordered')
assert.equal(rich.lines[appendedIndex].align, 'center')
assert.equal(rich.lines[appendedIndex].bold, true)
await shot('92-editor-rich-list')
await page.press('#editor', 'Escape')
await page.waitForSelector('#editor', { state: 'hidden' })
await page.waitForTimeout(250)
await shot('93-board-rich-note')

// Reopen and confirm the formatting survives an editor cycle.
await openEditor('seed-welcome')
const reopened = await page.evaluate(() =>
  [...document.querySelectorAll('#editor .note-line')].map((line) => ({
    text: line.textContent,
    list: line.getAttribute('data-list'),
    fontWeight: getComputedStyle(line).fontWeight,
  })),
)
assert.equal(reopened[0].list, 'bullet')
assert.equal(reopened[0].fontWeight, '700')
assert.ok(reopened.some((line) => line.text === 'Second rich line' && line.list === 'ordered'))
await page.press('#editor', 'Escape')

// A second client receives both the text and the formatting.
const contextB = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
const pageB = await contextB.newPage()
pageB.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
pageB.on('pageerror', (err) => errors.push(err.message))
await join(pageB)
await pageB.waitForFunction(() => {
  const note = window.__pinboard?.board.item('seed-welcome')
  return note?.type === 'note' && note.lines?.[0]?.bold === true && note.lines?.some((line) => line.text === 'Second rich line' && line.list === 'ordered')
}, null, { timeout: 15000 })

// Bob appends a line remotely.
await pageB.evaluate(() => window.__pinboard.setSelection(['seed-welcome']))
await pageB.click('#selectionBar [data-sel-action="edit"]')
await pageB.waitForSelector('#editor', { state: 'visible' })
await pageB.locator('#editor .note-line').last().click()
await pageB.keyboard.press('End')
await pageB.keyboard.press('Enter')
await pageB.keyboard.type('From Bob')
await pageB.press('#editor', 'Escape')
await page.waitForFunction(() => {
  const note = window.__pinboard?.board.item('seed-welcome')
  return note?.type === 'note' && note.lines?.some((line) => line.text === 'From Bob')
}, null, { timeout: 10000 })

// Create two fresh notes for lasso + grouping tests.
const groupIds = await page.evaluate(() => {
  const app = window.__pinboard
  const a = app.board.createNote({ x: 900, y: 80, w: 160, h: 140 }, '#fca5a5', 'Lasso A')
  const b = app.board.createNote({ x: 1160, y: 80, w: 160, h: 140 }, '#a7f3d0', 'Lasso B')
  app.board.stopCapturing()
  app.setSelection([])
  app.fitAll(true)
  app.requestRender()
  return [a, b]
})
await page.waitForTimeout(400)
const lassoBox = await page.evaluate((ids) => {
  const app = window.__pinboard
  const toScreen = (x, y) => ({
    x: (x - app.camera.x) * app.camera.scale,
    y: (y - app.camera.y) * app.camera.scale,
  })
  const notes = ids.map((id) => app.board.item(id))
  const left = Math.min(...notes.map((note) => note.x))
  const top = Math.min(...notes.map((note) => note.y))
  const right = Math.max(...notes.map((note) => note.x + note.w))
  const bottom = Math.max(...notes.map((note) => note.y + note.h))
  const tl = toScreen(left, top)
  const br = toScreen(right, bottom)
  return { left: tl.x, top: tl.y, right: br.x, bottom: br.y, width: br.x - tl.x, height: br.y - tl.y }
}, groupIds)
const midX = (lassoBox.left + lassoBox.right) / 2
const midY = (lassoBox.top + lassoBox.bottom) / 2
const lassoPath = [
  { x: lassoBox.left - 32, y: midY + 20 },
  { x: lassoBox.left - 48, y: lassoBox.top - 16 },
  { x: lassoBox.left + 20, y: lassoBox.top - 44 },
  { x: midX, y: lassoBox.top - 58 },
  { x: lassoBox.right - 20, y: lassoBox.top - 40 },
  { x: lassoBox.right + 46, y: lassoBox.top + 10 },
  { x: lassoBox.right + 40, y: lassoBox.bottom - 10 },
  { x: midX, y: lassoBox.bottom + 52 },
  { x: lassoBox.left + 30, y: lassoBox.bottom + 36 },
  { x: lassoBox.left - 20, y: lassoBox.bottom - 4 },
]
const clamped = await page.evaluate((points) => {
  const rect = document.getElementById('board').getBoundingClientRect()
  return points.map((point) => ({
    x: Math.max(4, Math.min(rect.width - 4, point.x)) + rect.left,
    y: Math.max(4, Math.min(rect.height - 4, point.y)) + rect.top,
  }))
}, lassoPath)

// Lasso tool: draw an irregular closed curve around both notes.
await page.click('[data-tool="lasso"]')
await page.mouse.move(clamped[0].x, clamped[0].y)
await page.mouse.down()
for (let i = 1; i < clamped.length; i++) {
  await page.mouse.move(clamped[i].x, clamped[i].y, { steps: 7 })
}
await page.mouse.move(clamped[0].x, clamped[0].y, { steps: 5 })
await page.mouse.up()
await page.waitForTimeout(300)
await shot('94-lasso-selection')
let selection = await page.evaluate(() => [...window.__pinboard.selection])
assert.equal(selection.length, 2, `lasso selects both notes (got ${selection.length})`)
await page.waitForSelector('#selectionBar:not([hidden])')
assert.equal((await page.locator('#selectionBar [data-sel-action="group"]').innerText()).trim(), 'Group')

// Group from the selection bar.
await page.click('#selectionBar [data-sel-action="group"]')
await page.waitForTimeout(250)
const grouped = await page.evaluate((ids) => ids.map((id) => window.__pinboard.board.item(id)?.groupId), groupIds)
assert.ok(grouped[0] && grouped[0] === grouped[1], 'both notes share one group')
await pageB.waitForFunction((ids) => {
  const app = window.__pinboard
  const first = app.board.item(ids[0])?.groupId
  return Boolean(first && first === app.board.item(ids[1])?.groupId)
}, groupIds, { timeout: 10000 })
await shot('95-grouped-selection')

await page.click('[data-tool="select"]')
await page.evaluate(() => window.__pinboard.setSelection([]))
await page.waitForTimeout(150)
const centerA = await page.evaluate((id) => {
  const app = window.__pinboard
  const note = app.board.item(id)
  const rect = document.getElementById('board').getBoundingClientRect()
  return {
    x: (note.x + note.w / 2 - app.camera.x) * app.camera.scale + rect.left,
    y: (note.y + note.h / 2 - app.camera.y) * app.camera.scale + rect.top,
  }
}, groupIds[0])
await page.mouse.click(centerA.x, centerA.y)
await page.waitForTimeout(170)
selection = await page.evaluate(() => [...window.__pinboard.selection])
assert.equal(selection.length, 2, 'clicking one group member selects the group')
const beforeMove = await page.evaluate((ids) => ids.map((id) => {
  const note = window.__pinboard.board.item(id)
  return { x: note.x, y: note.y }
}), groupIds)
await page.mouse.move(centerA.x, centerA.y)
await page.mouse.down()
await page.mouse.move(centerA.x + 48, centerA.y + 34, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(250)
const afterMove = await page.evaluate((ids) => ids.map((id) => {
  const note = window.__pinboard.board.item(id)
  return { x: note.x, y: note.y }
}), groupIds)
assert.ok(Math.abs(afterMove[0].x - beforeMove[0].x) > 20, 'grouped note A moved')
assert.ok(Math.abs(afterMove[1].x - beforeMove[1].x) > 20, 'grouped note B moved')

// Ungroup with the keyboard and verify both detach.
await page.keyboard.press('Control+Shift+g')
await page.waitForTimeout(250)
const ungrouped = await page.evaluate((ids) => ids.map((id) => window.__pinboard.board.item(id)?.groupId), groupIds)
assert.deepEqual(ungrouped, [null, null])
await page.evaluate(() => window.__pinboard.setSelection([]))
await page.waitForTimeout(150)
await page.mouse.click(centerA.x + 48, centerA.y + 34)
await page.waitForTimeout(180)
selection = await page.evaluate(() => [...window.__pinboard.selection])
assert.equal(selection.length, 1, 'after ungrouping a click selects only one note')
await shot('96-ungrouped')

// Export includes rich lines and survives reload.
await page.evaluate(() => window.__pinboard.setSelection(['seed-welcome']))
await page.click('#btnMenu')
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('[data-menu-action="export-json"]'),
])
const exportPath = `${shots}/rich-export.json`
await download.saveAs(exportPath)
const exported = JSON.parse(await readFile(exportPath, 'utf8'))
const exportedNote = exported.items.find((item) => item.id === 'seed-welcome')
assert.ok(Array.isArray(exportedNote.lines), 'export includes rich lines')
assert.equal(exportedNote.lines[0].bold, true)
assert.ok(exportedNote.lines.some((line) => line.text === 'Second rich line' && line.list === 'ordered'))
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__pinboard)
await page.waitForSelector('#nameModal', { state: 'hidden' })
await page.waitForFunction(() => {
  const text = document.getElementById('connState')?.innerText || ''
  return text.includes('Synced') || text.includes('已同步')
}, null, { timeout: 15000 })
await page.waitForFunction(() => {
  const note = window.__pinboard?.board.item('seed-welcome')
  return note?.type === 'note' && note.lines?.[0]?.bold === true && note.lines?.some((line) => line.text === 'Second rich line' && line.list === 'ordered')
}, null, { timeout: 15000 })
await page.waitForTimeout(400)
await shot('97-rich-after-reload')

// Traditional Chinese toolbar at a narrow desktop width.
await page.click('#btnMenu')
await page.click('[data-lang="zh-TW"]')
await page.waitForTimeout(250)
await page.setViewportSize({ width: 820, height: 680 })
await page.waitForTimeout(350)
await page.evaluate(() => {
  window.__pinboard.fitAll(true)
  window.__pinboard.requestRender()
})
await page.waitForTimeout(250)
await openEditor('seed-welcome')
await page.evaluate(() => {
  const editor = document.getElementById('editor')
  const line = editor?.querySelector('.note-line')
  if (!editor || !line) return
  editor.focus()
  const range = document.createRange()
  range.selectNodeContents(line)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
})
await page.waitForTimeout(200)
const narrowLayout = await page.evaluate(() => {
  const bar = document.getElementById('formatBar')
  const rect = bar.getBoundingClientRect()
  return {
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
    barLeft: rect.left,
    barRight: rect.right,
    barWidth: rect.width,
    viewport: innerWidth,
    sizeLabel: document.querySelector('#fmtSize option:checked')?.textContent,
  }
})
assert.equal(narrowLayout.pageOverflow, 0)
assert.ok(narrowLayout.barLeft >= 0 && narrowLayout.barRight <= narrowLayout.viewport)
assert.equal(narrowLayout.sizeLabel, '大')
await shot('98-rich-toolbar-zh-tw-820')
await page.press('#editor', 'Escape')

if (errors.length) console.log('CONSOLE ERRORS', errors)
console.log('RICH GROUP LASSO PASSED', JSON.stringify({ room, groupLineCount: rich.lines.length, selection, exportedLines: exportedNote.lines.length, narrowLayout }))
await browser.close()
