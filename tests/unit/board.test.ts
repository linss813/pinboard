import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Board } from '../../src/board'
import type { NoteItem } from '../../shared/types'

function makeBoard(): Board {
  return new Board(new Y.Doc())
}

function noteItem(board: Board, id: string): NoteItem {
  const item = board.item(id)
  if (!item || item.type !== 'note') throw new Error('expected a note')
  return item
}

describe('board commands', () => {
  it('locks geometry and delete while pinned, but still allows editing', () => {
    const board = makeBoard()
    const id = board.createNote({ x: 0, y: 0, w: 180, h: 180 }, '#fde68a', 'hello')
    board.stopCapturing()
    expect(board.togglePin([id])?.pinned).toBe(true)
    board.stopCapturing()

    expect(board.moveItems([id], 30, 30)).toEqual([id])
    expect(board.item(id)!.pinned).toBe(true)
    expect(noteItem(board, id).x).toBe(0)
    expect(board.deleteItems([id]).ok).toBe(false)
    expect(board.item(id)!.deleted).toBe(false)

    board.setNoteText(id, 'still editable')
    expect(noteItem(board, id).text).toBe('still editable')

    expect(board.togglePin([id])?.pinned).toBe(false)
    board.stopCapturing()
    expect(board.moveItems([id], 30, 30)).toEqual([])
    expect(noteItem(board, id).x).toBe(30)
    expect(board.deleteItems([id]).ok).toBe(true)
    expect(board.item(id)!.deleted).toBe(true)
  })

  it('cascades connector deletion when a note is removed', () => {
    const board = makeBoard()
    const a = board.createNote({ x: 0, y: 0, w: 100, h: 100 }, '#fde68a')
    const b = board.createNote({ x: 300, y: 0, w: 100, h: 100 }, '#bfdbfe')
    const c = board.createConnector({ noteId: a }, { noteId: b })!
    board.stopCapturing()
    const result = board.deleteItems([a])
    expect(result.ok).toBe(true)
    expect(result.deleted).toContain(c)
    expect(board.item(c)!.deleted).toBe(true)
  })

  it('undoes and redoes local commands only', () => {
    const board = makeBoard()
    const id = board.createNote({ x: 0, y: 0, w: 100, h: 100 }, '#fde68a', 'one')
    board.stopCapturing()
    board.setNoteText(id, 'two')
    board.stopCapturing()
    expect(noteItem(board, id).text).toBe('two')
    expect(board.undo()).toBe(true)
    expect(noteItem(board, id).text).toBe('one')
    expect(board.redo()).toBe(true)
    expect(noteItem(board, id).text).toBe('two')
  })

  it('duplicates content as unpinned copies', () => {
    const board = makeBoard()
    const id = board.createNote({ x: 10, y: 10, w: 100, h: 100 }, '#fde68a', 'copy')
    board.togglePin([id])
    board.stopCapturing()
    const [copy] = board.duplicateItems([id])
    expect(copy).toBeTruthy()
    expect(copy).not.toBe(id)
    const copyItem = noteItem(board, copy)
    expect(copyItem.pinned).toBe(false)
    expect(copyItem.text).toBe('copy')
    expect(copyItem.x).toBe(36)
  })

  it('refuses to pin connectors', () => {
    const board = makeBoard()
    const a = board.createNote({ x: 0, y: 0, w: 100, h: 100 }, '#fde68a')
    const b = board.createNote({ x: 300, y: 0, w: 100, h: 100 }, '#bfdbfe')
    const connector = board.createConnector({ noteId: a }, { noteId: b })!
    board.stopCapturing()
    expect(board.togglePin([connector])).toBeNull()
  })

  it('stores pen style, pressure samples and custom colors across copies and imports', () => {
    const board = makeBoard()
    const id = board.beginStroke('#0f766e', 9, { x: 10, y: 10, pressure: 0.25 }, 'highlighter')
    board.appendStrokePoints(id, [
      { x: 20, y: 14, pressure: 0.8 },
      { x: 32, y: 18 },
    ])
    board.stopCapturing()
    const stroke = board.item(id)
    expect(stroke?.type).toBe('stroke')
    if (stroke?.type !== 'stroke') throw new Error('expected a stroke')
    expect(stroke.style).toBe('highlighter')
    expect(stroke.color).toBe('#0f766e')
    expect(stroke.width).toBe(9)
    expect(stroke.points).toEqual([
      { x: 10, y: 10, pressure: 0.25 },
      { x: 20, y: 14, pressure: 0.8 },
      { x: 32, y: 18 },
    ])

    const [copyId] = board.duplicateItems([id])
    const copy = board.item(copyId)
    expect(copy?.type).toBe('stroke')
    if (copy?.type === 'stroke') {
      expect(copy.style).toBe('highlighter')
      expect(copy.color).toBe('#0f766e')
      expect(copy.points[0].pressure).toBe(0.25)
      expect(copy.pressureSensitivity).toBe(0.65)
    }

    const pressureId = board.beginStroke('#334155', 6, { x: 0, y: 0, pressure: 0.9 }, 'pen', 0.25)
    const pressureStroke = board.item(pressureId)
    expect(pressureStroke?.type).toBe('stroke')
    if (pressureStroke?.type === 'stroke') {
      expect(pressureStroke.pressureSensitivity).toBe(0.25)
    }

    const importId = board.importItems([
      {
        ...stroke,
        id: 'imported-stroke',
        points: [{ x: 0, y: 0, pressure: 0.6 }, { x: 20, y: 10 }],
      },
    ]).ids[0]
    const imported = board.item(importId)
    expect(imported?.type).toBe('stroke')
    if (imported?.type === 'stroke') {
      expect(imported.style).toBe('highlighter')
      expect(imported.color).toBe('#0f766e')
      expect(imported.points[0].pressure).toBe(0.6)
    }
  })

  it('stores rich lines with formatting and undoes formatting changes', () => {
    const board = makeBoard()
    const id = board.createNote({ x: 0, y: 0, w: 220, h: 180 }, '#fde68a', 'Title\nBody')
    const lines = noteItem(board, id).lines!
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => line.text)).toEqual(['Title', 'Body'])
    board.stopCapturing()
    board.setLineAttrs(id, [lines[0].id], {
      size: 'xl',
      bold: true,
      italic: true,
      underline: true,
      list: 'ordered',
      align: 'center',
    })
    board.stopCapturing()
    const styled = noteItem(board, id).lines!
    expect(styled[0]).toMatchObject({
      size: 'xl',
      bold: true,
      italic: true,
      underline: true,
      list: 'ordered',
      align: 'center',
    })
    expect(styled[1]).toMatchObject({ size: 'm', bold: false, list: 'none' })
    board.undo()
    expect(noteItem(board, id).lines![0]).toMatchObject({ size: 'm', bold: false, list: 'none' })
    board.redo()
    expect(noteItem(board, id).lines![0]).toMatchObject({ size: 'xl', bold: true, list: 'ordered' })
  })

  it('edits rich line text and keeps formatting when replacing plain text', () => {
    const board = makeBoard()
    const id = board.createNote({ x: 0, y: 0, w: 220, h: 180 }, '#fde68a', 'One')
    board.setLineAttrs(id, noteItem(board, id).lines!.map((line) => line.id), { bold: true, list: 'bullet' })
    board.stopCapturing()
    const lines = noteItem(board, id).lines!
    board.setNoteLines(id, [{ ...lines[0], text: 'Changed' }])
    expect(noteItem(board, id).text).toBe('Changed')
    expect(noteItem(board, id).lines![0]).toMatchObject({ text: 'Changed', bold: true, list: 'bullet' })
    board.setNoteText(id, 'A\nB')
    expect(noteItem(board, id).text).toBe('A\nB')
    expect(noteItem(board, id).lines).toHaveLength(2)
    expect(noteItem(board, id).lines![0].bold).toBe(true)
  })

  it('creates and edits transparent text boxes, including copies and imports', () => {
    const board = makeBoard()
    const id = board.createText({ x: 30, y: 40, w: 260, h: 52 }, '#0f766e', 28, 'Hello\ntext')
    const text = board.item(id)
    expect(text?.type).toBe('text')
    if (text?.type !== 'text') throw new Error('expected a text item')
    expect(text.text).toBe('Hello\ntext')
    expect(text.fontSize).toBe(28)
    expect(text.color).toBe('#0f766e')
    board.setTextContent(id, 'Edited line')
    board.setTextColor(id, '#1f2937')
    board.setTextSize(id, 20)
    board.setBoxRect(id, { h: 80 })
    expect(board.item(id)).toMatchObject({
      type: 'text',
      text: 'Edited line',
      color: '#1f2937',
      fontSize: 20,
      h: 80,
    })
    expect(board.togglePin([id])?.pinned).toBe(true)
    board.stopCapturing()

    const [copyId] = board.duplicateItems([id])
    const copy = board.item(copyId)
    expect(copy?.type).toBe('text')
    if (copy?.type === 'text') {
      expect(copy.text).toBe('Edited line')
      expect(copy.fontSize).toBe(20)
      expect(copy.color).toBe('#1f2937')
      expect(copy.pinned).toBe(false)
      expect(copy.x).toBe(56)
    }

    const importId = board.importItems([{ ...text, id: 'imported-text', text: 'From JSON' }]).ids[0]
    expect(board.item(importId)).toMatchObject({ type: 'text', text: 'From JSON', fontSize: 28 })
  })

  it('deletes only unpinned items in a mixed selection and preserves pinned connectors', () => {
    const board = makeBoard()
    const pinned = board.createNote({ x: 0, y: 0, w: 100, h: 100 }, '#fde68a')
    const disposable = board.createNote({ x: 200, y: 0, w: 100, h: 100 }, '#bfdbfe')
    const bystander = board.createNote({ x: 400, y: 0, w: 100, h: 100 }, '#a7f3d0')
    const pinnedConnector = board.createConnector({ noteId: pinned }, { noteId: bystander })!
    const disposableConnector = board.createConnector({ noteId: disposable }, { noteId: bystander })!
    board.togglePin([pinned])
    board.stopCapturing()

    const result = board.deleteItems([pinned, disposable])
    expect(result.ok).toBe(true)
    expect(result.blocked).toEqual([pinned])
    expect(result.deleted).toContain(disposable)
    expect(result.deleted).toContain(disposableConnector)
    expect(result.deleted).not.toContain(pinned)
    expect(result.deleted).not.toContain(pinnedConnector)
    expect(board.item(pinned)!.deleted).toBe(false)
    expect(board.item(disposable)!.deleted).toBe(true)
    expect(board.item(disposableConnector)!.deleted).toBe(true)
    expect(board.item(pinnedConnector)!.deleted).toBe(false)

    expect(board.deleteItems([pinned])).toMatchObject({ ok: false, blocked: [pinned], deleted: [] })
    expect(board.item(pinned)!.deleted).toBe(false)
  })

  it('groups selected items, expands group selection and cleans up small groups', () => {
    const board = makeBoard()
    const a = board.createNote({ x: 0, y: 0, w: 100, h: 100 }, '#fde68a')
    const b = board.createNote({ x: 200, y: 0, w: 100, h: 100 }, '#bfdbfe')
    const c = board.createNote({ x: 400, y: 0, w: 100, h: 100 }, '#a7f3d0')
    board.stopCapturing()
    const groupId = board.groupItems([a, b])!
    expect(groupId).toBeTruthy()
    expect(board.item(a)!.groupId).toBe(groupId)
    expect(board.item(b)!.groupId).toBe(groupId)
    expect(board.item(c)!.groupId).toBeNull()
    expect(board.expandGroups([a]).sort()).toEqual([a, b].sort())
    expect(board.groupItems([c])).toBeNull()

    const copies = board.duplicateItems([a, b])
    expect(copies).toHaveLength(2)
    const copyGroup = board.item(copies[0])!.groupId
    expect(copyGroup).toBeTruthy()
    expect(board.item(copies[1])!.groupId).toBe(copyGroup)
    expect(copyGroup).not.toBe(board.item(a)!.groupId)

    const deleted = board.deleteItems([a])
    expect(deleted.ok).toBe(true)
    expect(board.item(b)!.groupId).toBeNull()
  })

  it('ungroups a selection and remaps groups on import', () => {
    const board = makeBoard()
    const a = board.createNote({ x: 0, y: 0, w: 100, h: 100 }, '#fde68a')
    const b = board.createNote({ x: 200, y: 0, w: 100, h: 100 }, '#bfdbfe')
    const groupId = board.groupItems([a, b])!
    expect(board.ungroupItems([a])).toBe(true)
    expect(board.item(a)!.groupId).toBeNull()
    expect(board.item(b)!.groupId).toBeNull()

    const sourceItems = board.visibleItems().map((item) => ({ ...item, id: `${item.id}-import` }))
    sourceItems[0].groupId = 'group-src'
    sourceItems[1].groupId = 'group-src'
    const result = board.importItems(sourceItems)
    expect(result.ids).toHaveLength(2)
    const imported = result.ids.map((id) => board.item(id)!)
    expect(imported[0].groupId).toBeTruthy()
    expect(imported[0].groupId).toBe(imported[1].groupId)
    expect(imported[0].groupId).not.toBe('group-src')
    expect(board.visibleItems().find((item) => item.id === a)!.groupId).toBeNull()
    expect(groupId).toBeTruthy()
  })
})
