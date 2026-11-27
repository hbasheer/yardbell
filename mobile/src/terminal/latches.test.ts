import { expect, test } from 'vitest'
import { consumeLatches, modsOf, NO_LATCHES, tapLatch } from './latches'

test('a tap arms, a second slow tap releases', () => {
  const armed = tapLatch(NO_LATCHES, 'ctrl', false)
  expect(armed.ctrl).toBe('once')
  expect(tapLatch(armed, 'ctrl', false).ctrl).toBe('off')
})

test('a double tap locks', () => {
  const locked = tapLatch(tapLatch(NO_LATCHES, 'shift', false), 'shift', true)
  expect(locked.shift).toBe('locked')
  expect(tapLatch(locked, 'shift', false).shift).toBe('off')
})

test('the next key releases armed latches and keeps locked ones', () => {
  const held = { shift: 'locked', ctrl: 'once', alt: 'off' } as const
  expect(modsOf(held)).toEqual({ shift: true, ctrl: true, alt: false })
  expect(consumeLatches(held)).toEqual({ shift: 'locked', ctrl: 'off', alt: 'off' })
})
