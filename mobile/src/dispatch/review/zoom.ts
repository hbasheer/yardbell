export const MAX_ZOOM = 8
export const DOUBLE_TAP_ZOOM = 2.5

export function fitScale(imageWidth: number, imageHeight: number, viewWidth: number, viewHeight: number): number {
  'worklet'
  if (imageWidth <= 0 || imageHeight <= 0 || viewWidth <= 0 || viewHeight <= 0) return 1
  return Math.min(viewWidth / imageWidth, viewHeight / imageHeight)
}

export function clampScale(scale: number, min: number, max: number): number {
  'worklet'
  return Math.min(Math.max(scale, min), max)
}

export function clampOffset(offset: number, shown: number, view: number): number {
  'worklet'
  const limit = Math.max(0, (shown - view) / 2)
  return Math.min(Math.max(offset, -limit), limit)
}

export function actualScale(fit: number): number {
  'worklet'
  return fit > 0 ? 1 / fit : 1
}

export function doubleTapTarget(current: number, fit: number): number {
  'worklet'
  if (current > 1.01) return 1
  const actual = actualScale(fit)
  return actual > 1.2 ? actual : DOUBLE_TAP_ZOOM
}

export function pinchOffset(focal: number, start: number, savedOffset: number, savedScale: number, scale: number): number {
  'worklet'
  const under = (start - savedOffset) / savedScale
  return focal - under * scale
}
