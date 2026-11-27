import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createRepeater } from './repeat'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

test('a tap sends once, on release', () => {
  const fire = vi.fn()
  const r = createRepeater(fire)
  r.pressIn()
  expect(fire).not.toHaveBeenCalled()
  vi.advanceTimersByTime(100)
  r.pressOut()
  r.press()
  expect(fire).toHaveBeenCalledTimes(1)
})

test('a press that turns into a scroll sends nothing', () => {
  const fire = vi.fn()
  const r = createRepeater(fire)
  r.pressIn()
  vi.advanceTimersByTime(100)
  r.pressOut()
  vi.advanceTimersByTime(1000)
  expect(fire).not.toHaveBeenCalled()
})

test('holding repeats after the delay and the release does not add a send', () => {
  const fire = vi.fn()
  const r = createRepeater(fire)
  r.pressIn()
  vi.advanceTimersByTime(400)
  expect(fire).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(90)
  expect(fire).toHaveBeenCalledTimes(3)
  r.pressOut()
  r.press()
  vi.advanceTimersByTime(500)
  expect(fire).toHaveBeenCalledTimes(3)
})
