import { expect, test } from 'vitest'
import {
  bottomDrawerDismissMotion,
  bottomDrawerDragProgress,
  bottomDrawerOffset,
  bottomDrawerScrim,
  bottomDrawerTravel,
  shouldDismissBottomDrawer
} from './motion'

test('the sheet travels its own height plus a margin, capped at the screen', () => {
  expect(bottomDrawerTravel(300, 800)).toBe(348)
  expect(bottomDrawerTravel(790, 800)).toBe(800)
})

test('progress 1 is open and 0 is parked below', () => {
  expect(bottomDrawerOffset(1, 348)).toBe(0)
  expect(bottomDrawerOffset(0, 348)).toBe(348)
})

test('the scrim is gone exactly when the sheet is', () => {
  expect(bottomDrawerScrim(0, 348, 300)).toBe(0)
  expect(bottomDrawerScrim(1, 348, 300)).toBe(1)
})

test('pulling up is damped to a quarter', () => {
  expect(bottomDrawerDragProgress(-40, 400)).toBeCloseTo(1 + 10 / 400)
  expect(bottomDrawerDragProgress(40, 400)).toBeCloseTo(1 - 40 / 400)
})

test('a fast downward flick closes, a slow short drag does not', () => {
  expect(shouldDismissBottomDrawer(10, 900, 300)).toBe(true)
  expect(shouldDismissBottomDrawer(20, 0, 300)).toBe(false)
  expect(shouldDismissBottomDrawer(180, 0, 300)).toBe(true)
})

test('tall sheets close past 200 px rather than half their height', () => {
  expect(shouldDismissBottomDrawer(210, 0, 800)).toBe(true)
  expect(shouldDismissBottomDrawer(190, 0, 800)).toBe(false)
})

test('a dismiss never runs longer than the hide duration or shorter than 160 ms', () => {
  expect(bottomDrawerDismissMotion(0, 0, 400, 300).duration).toBe(300)
  expect(bottomDrawerDismissMotion(390, 5000, 400, 300).duration).toBe(160)
})
