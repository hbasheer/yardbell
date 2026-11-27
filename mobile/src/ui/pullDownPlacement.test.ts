import { expect, test } from 'vitest'
import { EDGE_INSET, MENU_WIDTH, pullDownAnchor, pullDownMaxHeight } from './pullDownPlacement'

const window = { width: 400, height: 800 }

test('a button in the upper half drops the menu below it, right-aligned', () => {
  const anchor = pullDownAnchor({ x: 340, y: 10, width: 36, height: 36 }, window)
  expect(anchor).toEqual({ top: 10 + 36 + 6, right: 400 - 376 })
})

test('a button in the lower half flips the menu above it', () => {
  const anchor = pullDownAnchor({ x: 340, y: 700, width: 36, height: 36 }, window)
  expect(anchor).toEqual({ bottom: 800 - 700 + 6, right: 24 })
})

test('the midpoint of the button decides the half', () => {
  expect('top' in pullDownAnchor({ x: 0, y: 382, width: 36, height: 36 }, window)).toBe(true)
  expect('bottom' in pullDownAnchor({ x: 0, y: 383, width: 36, height: 36 }, window)).toBe(true)
})

test('a button at the screen edge keeps the menu 8 px inside it', () => {
  const anchor = pullDownAnchor({ x: 370, y: 10, width: 36, height: 36 }, window)
  expect(anchor.right).toBe(EDGE_INSET)
})

test('the menu never grows past the screen edge it hangs toward', () => {
  expect(pullDownMaxHeight({ top: 100, right: 8 }, 800)).toBe(800 - 100 - EDGE_INSET)
  expect(pullDownMaxHeight({ bottom: 100, right: 8 }, 800)).toBe(800 - 100 - EDGE_INSET)
  expect(MENU_WIDTH).toBe(252)
})
