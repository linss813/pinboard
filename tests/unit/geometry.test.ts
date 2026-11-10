import { describe, expect, it } from 'vitest'
import {
  connectorEndpoints,
  contentBounds,
  edgePointToward,
  handlePoints,
  hitItem,
  itemBounds,
  pinAnchor,
  pointInRect,
  pointInPolygon,
  rectsIntersect,
} from '../../shared/geometry'
import type { ConnectorItem, NoteItem, StrokeItem } from '../../shared/types'

function note(id: string, x: number, y: number, w = 100, h = 100): NoteItem {
  return {
    id,
    type: 'note',
    z: 0,
    pinned: false,
    pinnedAt: null,
    deleted: false,
    x,
    y,
    w,
    h,
    color: '#fde68a',
    text: '',
  }
}

function connector(a: ConnectorItem['a'], b: ConnectorItem['b']): ConnectorItem {
  return {
    id: 'c',
    type: 'connector',
    z: 0,
    pinned: false,
    pinnedAt: null,
    deleted: false,
    a,
    b,
  }
}

describe('geometry', () => {
  it('anchors connectors on note edges, not note centres', () => {
    const notes = new Map([
      ['a', note('a', 0, 0)],
      ['b', note('b', 300, 0)],
    ])
    const ends = connectorEndpoints(connector({ noteId: 'a' }, { noteId: 'b' }), notes)
    expect(ends).not.toBeNull()
    expect(ends![0]).toEqual({ x: 100, y: 50 })
    expect(ends![1]).toEqual({ x: 300, y: 50 })
  })

  it('supports free connector endpoints and skips missing notes', () => {
    const notes = new Map([['a', note('a', 0, 0)]])
    const ends = connectorEndpoints(connector({ noteId: 'a' }, { x: 300, y: 50 }), notes)
    expect(ends![1]).toEqual({ x: 300, y: 50 })
    expect(connectorEndpoints(connector({ noteId: 'missing' }, { x: 0, y: 0 }), notes)).toBeNull()
  })

  it('clips an edge point toward a target', () => {
    expect(edgePointToward({ x: 0, y: 0, w: 100, h: 100 }, { x: 300, y: 50 })).toEqual({ x: 100, y: 50 })
  })

  it('puts the pin at the top centre of notes and images, and on stroke bounds', () => {
    expect(pinAnchor(note('a', 10, 20, 100, 100), new Map())).toEqual({ x: 60, y: 20 })
    const stroke: StrokeItem = {
      id: 's',
      type: 'stroke',
      z: 0,
      pinned: false,
      pinnedAt: null,
      deleted: false,
      x: 5,
      y: 10,
      points: [
        { x: 0, y: 0 },
        { x: 20, y: 20 },
      ],
      color: '#334155',
      width: 4,
    }
    const bounds = itemBounds(stroke, new Map())
    expect(pinAnchor(stroke, new Map())!.x).toBeCloseTo(bounds.x + bounds.w / 2)
    expect(pinAnchor(stroke, new Map())!.y).toBeCloseTo(bounds.y)
  })

  it('hits notes and strokes with their offsets applied', () => {
    const n = note('a', 0, 0)
    expect(hitItem(n, { x: 10, y: 10 }, new Map())).toBe(true)
    expect(hitItem(n, { x: -10, y: -10 }, new Map())).toBe(false)
    const stroke: StrokeItem = {
      id: 's',
      type: 'stroke',
      z: 0,
      pinned: false,
      pinnedAt: null,
      deleted: false,
      x: 100,
      y: 100,
      points: [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
      ],
      color: '#334155',
      width: 4,
    }
    expect(hitItem(stroke, { x: 120, y: 101 }, new Map())).toBe(true)
    expect(hitItem(stroke, { x: 20, y: 20 }, new Map())).toBe(false)
  })

  it('exposes seven handles without a top-centre handle (the pin owns it)', () => {
    const points = handlePoints({ x: 0, y: 0, w: 100, h: 100 })
    expect(Object.keys(points).sort()).toEqual(['e', 'ne', 'nw', 's', 'se', 'sw', 'w'])
  })

  it('computes content bounds and rect intersections', () => {
    const notes = new Map([
      ['a', note('a', 0, 0)],
      ['b', note('b', 200, 100)],
    ])
    const bounds = contentBounds([...notes.values()], notes)
    expect(bounds).toEqual({ x: 0, y: 0, w: 300, h: 200 })
    expect(rectsIntersect({ x: 0, y: 0, w: 50, h: 50 }, { x: 40, y: 40, w: 50, h: 50 })).toBe(true)
    expect(pointInRect({ x: 10, y: 10 }, { x: 0, y: 0, w: 20, h: 20 })).toBe(true)
  })

  it('selects points inside arbitrary and concave lasso paths, including edges', () => {
    const triangle = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 40, y: 80 },
    ]
    expect(pointInPolygon({ x: 30, y: 30 }, triangle)).toBe(true)
    expect(pointInPolygon({ x: 90, y: 70 }, triangle)).toBe(false)
    expect(pointInPolygon({ x: 50, y: 0 }, triangle)).toBe(true)

    const concave = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 60, y: 100 },
      { x: 60, y: 40 },
      { x: 40, y: 40 },
      { x: 40, y: 100 },
      { x: 0, y: 100 },
    ]
    expect(pointInPolygon({ x: 20, y: 20 }, concave)).toBe(true)
    expect(pointInPolygon({ x: 50, y: 70 }, concave)).toBe(false)
    expect(pointInPolygon({ x: 50, y: 20 }, [...concave].reverse())).toBe(true)
    expect(pointInPolygon({ x: 20, y: 20 }, triangle.slice(0, 2))).toBe(false)

    const duplicated = [...triangle, { x: 0, y: 0 }]
    expect(pointInPolygon({ x: 900, y: 900 }, duplicated)).toBe(false)
    expect(pointInPolygon({ x: 30, y: 30 }, duplicated)).toBe(true)
  })
})
