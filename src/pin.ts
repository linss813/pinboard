import type { Point } from '../shared/types'

const ANGLE = -0.21
const DESIGN_SIZE = 22
const HEAD_Y = -17
const HEAD_R = 7.4
const NEEDLE_END = -9.5

function rotatePoint(p: Point, angle: number): Point {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }
}

export function pinHeadCenter(tip: Point, size = DESIGN_SIZE): Point {
  const offset = rotatePoint({ x: 0, y: HEAD_Y * (size / DESIGN_SIZE) }, ANGLE)
  return { x: tip.x + offset.x, y: tip.y + offset.y }
}

export function hitPin(screenPoint: Point, tip: Point, size = DESIGN_SIZE): boolean {
  const head = pinHeadCenter(tip, size)
  const radius = Math.max(13, HEAD_R * (size / DESIGN_SIZE) + 6)
  if (Math.hypot(screenPoint.x - head.x, screenPoint.y - head.y) <= radius) return true
  const scaledEnd = rotatePoint({ x: 0, y: NEEDLE_END * (size / DESIGN_SIZE) }, ANGLE)
  const end = { x: tip.x + scaledEnd.x, y: tip.y + scaledEnd.y }
  const dx = end.x - tip.x
  const dy = end.y - tip.y
  const l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((screenPoint.x - tip.x) * dx + (screenPoint.y - tip.y) * dy) / l2)) : 0
  const nx = tip.x + dx * t
  const ny = tip.y + dy * t
  return Math.hypot(screenPoint.x - nx, screenPoint.y - ny) <= 5
}

export function drawPin(
  ctx: CanvasRenderingContext2D,
  tip: Point,
  options: { pinned: boolean; hovered?: boolean; size?: number; ghost?: boolean },
): void {
  const { pinned, hovered = false, size = DESIGN_SIZE, ghost = !pinned } = options
  const s = size / DESIGN_SIZE
  ctx.save()
  ctx.translate(tip.x, tip.y)
  ctx.rotate(ANGLE)
  ctx.scale(s * (hovered ? 1.12 : 1), s * (hovered ? 1.12 : 1))

  if (ghost) {
    ctx.globalAlpha = hovered ? 0.9 : 0.42
  }

  if (hovered) {
    ctx.shadowColor = pinned ? 'rgba(229,72,77,.55)' : 'rgba(79,142,247,.4)'
    ctx.shadowBlur = 12
  }

  // soft shadow below the head
  if (!ghost) {
    ctx.globalAlpha = 0.22
    ctx.fillStyle = '#0f172a'
    ctx.beginPath()
    ctx.ellipse(1.8, HEAD_Y + 7.5, 7.4, 3.1, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
  }
  ctx.shadowBlur = 0

  // needle
  const steel = ctx.createLinearGradient(-1.2, 0, 1.2, NEEDLE_END)
  steel.addColorStop(0, '#e2e8f0')
  steel.addColorStop(0.5, '#94a3b8')
  steel.addColorStop(1, '#64748b')
  ctx.strokeStyle = '#475569'
  ctx.lineWidth = 3.4
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(0, -1)
  ctx.lineTo(0, NEEDLE_END + 1.5)
  ctx.stroke()
  ctx.strokeStyle = steel
  ctx.lineWidth = 1.8
  ctx.beginPath()
  ctx.moveTo(0, -1)
  ctx.lineTo(0, NEEDLE_END + 1.5)
  ctx.stroke()

  // neck
  ctx.fillStyle = '#c24148'
  ctx.beginPath()
  ctx.moveTo(-3.1, -12.8)
  ctx.lineTo(3.1, -12.8)
  ctx.lineTo(2.4, NEEDLE_END + 1)
  ctx.lineTo(-2.4, NEEDLE_END + 1)
  ctx.closePath()
  ctx.fill()

  // head
  const headGradient = ctx.createRadialGradient(-2.4, HEAD_Y - 2.8, 0.8, 0, HEAD_Y, HEAD_R + 2)
  headGradient.addColorStop(0, '#ff9b9e')
  headGradient.addColorStop(0.42, '#ee575d')
  headGradient.addColorStop(1, '#bd2730')
  ctx.fillStyle = headGradient
  ctx.strokeStyle = 'rgba(108,15,21,.72)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(0, HEAD_Y, HEAD_R, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()

  // specular highlight
  ctx.globalAlpha = 0.65
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.ellipse(-2.6, HEAD_Y - 3.1, 2.1, 1.5, -0.55, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1

  // base ring
  ctx.strokeStyle = 'rgba(255,255,255,.35)'
  ctx.lineWidth = 0.9
  ctx.beginPath()
  ctx.arc(0, HEAD_Y + 1.6, HEAD_R - 2.2, 0.15, Math.PI - 0.15)
  ctx.stroke()

  ctx.restore()
}
