export const SHEET_CURVE = [0.32, 0.72, 0, 1] as const
export const SHEET_HEIGHT_DURATION_MS = 320
export const SETTLE_SPRING = { dampingRatio: 1, duration: 350 } as const
export const REDUCED_MOTION_FADE_MS = 200
export const REDUCED_MOTION_DISMISS_FADE_MS = 150
export const BOTTOM_DRAWER_SHOW_DURATION_MS = 480
export const BOTTOM_DRAWER_HIDE_DURATION_MS = 300

const OFFSCREEN_MARGIN = 48
const RUBBER_BAND_FACTOR = 0.25
const RELEASE_PROJECTION_S = 0.15
const FLICK_VELOCITY = 800
const DISMISS_DISTANCE_CAP = 200
const MIN_DISMISS_MS = 160
const DISMISS_CURVE_X1 = 0.3

export function bottomDrawerTravel(sheetHeight: number, screenHeight: number): number {
  'worklet'
  return Math.min(sheetHeight + OFFSCREEN_MARGIN, screenHeight)
}

export function bottomDrawerOffset(progress: number, travel: number): number {
  'worklet'
  return (1 - Math.max(progress, 0)) * travel
}

export function bottomDrawerScrim(progress: number, travel: number, sheetHeight: number): number {
  'worklet'
  if (sheetHeight <= 0) return Math.min(Math.max(progress, 0), 1)
  const visible = 1 - bottomDrawerOffset(progress, travel) / sheetHeight
  return Math.min(Math.max(visible, 0), 1)
}

export function bottomDrawerDragProgress(dragOffset: number, travel: number): number {
  'worklet'
  const offset = dragOffset >= 0 ? dragOffset : dragOffset * RUBBER_BAND_FACTOR
  return travel > 0 ? 1 - offset / travel : 1
}

export function shouldDismissBottomDrawer(offset: number, velocityY: number, sheetHeight: number): boolean {
  'worklet'
  if (velocityY > FLICK_VELOCITY) return true
  const projected = offset + velocityY * RELEASE_PROJECTION_S
  return projected > Math.min(sheetHeight / 2, DISMISS_DISTANCE_CAP)
}

export function bottomDrawerDismissMotion(
  offset: number,
  velocityY: number,
  travel: number,
  hideDurationMs: number
): { duration: number; x1: number; y1: number } {
  'worklet'
  const remaining = Math.max(travel - offset, 1)
  const speed = Math.max(velocityY, 0)
  const steepest = ((remaining / DISMISS_CURVE_X1) * 1000) / Math.max(speed, 1)
  const duration = Math.max(Math.min(hideDurationMs, steepest), MIN_DISMISS_MS)
  const startSlope = (speed * duration) / 1000 / remaining
  return { duration, x1: DISMISS_CURVE_X1, y1: Math.min(startSlope * DISMISS_CURVE_X1, 1) }
}
