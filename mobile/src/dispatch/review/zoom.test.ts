import { describe, expect, it } from 'vitest'
import { actualScale, clampOffset, clampScale, doubleTapTarget, fitScale, MAX_ZOOM, pinchOffset } from './zoom'

describe('zoom', () => {
  it('fits the whole image in the view', () => {
    expect(fitScale(1000, 500, 400, 800)).toBe(0.4)
    expect(fitScale(100, 400, 400, 200)).toBe(0.5)
    expect(fitScale(0, 0, 400, 800)).toBe(1)
  })
  it('clamps scale', () => {
    expect(clampScale(0.2, 1, MAX_ZOOM)).toBe(1)
    expect(clampScale(20, 1, MAX_ZOOM)).toBe(MAX_ZOOM)
  })
  it('keeps the image from being dragged off the view', () => {
    expect(clampOffset(500, 800, 400)).toBe(200)
    expect(clampOffset(-500, 800, 400)).toBe(-200)
    expect(clampOffset(50, 300, 400)).toBe(0)
  })
  it('toggles between fit and actual size on double tap', () => {
    expect(actualScale(0.4)).toBe(2.5)
    expect(doubleTapTarget(1, 0.4)).toBe(2.5)
    expect(doubleTapTarget(2.5, 0.4)).toBe(1)
    expect(doubleTapTarget(1, 1)).toBe(2.5)
  })
  it('keeps the point under the fingers still while pinching', () => {
    expect(pinchOffset(100, 100, 0, 1, 2)).toBe(-100)
    expect(pinchOffset(0, 0, 0, 1, 3)).toBe(0)
  })
})
