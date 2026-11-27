import { expect, test } from 'vitest'
import { palettes } from './palette'
import { applyColorScheme, colors, getColorScheme, resolveScheme, subscribeColorScheme } from './scheme'

test('dark and light palettes have the same keys', () => {
  expect(Object.keys(palettes.light).sort()).toEqual(Object.keys(palettes.dark).sort())
})

test('every palette value is a colour string', () => {
  for (const palette of Object.values(palettes)) {
    for (const [key, value] of Object.entries(palette)) {
      expect(value, key).toMatch(/^(#[0-9a-f]{3,8}|rgba?\(.+\))$/i)
    }
  }
})

test('resolveScheme follows the system only for the system preference', () => {
  expect(resolveScheme('system', 'light')).toBe('light')
  expect(resolveScheme('system', 'dark')).toBe('dark')
  expect(resolveScheme('system', 'unspecified')).toBe('dark')
  expect(resolveScheme('system', null)).toBe('dark')
  expect(resolveScheme('light', 'dark')).toBe('light')
  expect(resolveScheme('dark', 'light')).toBe('dark')
})

test('applyColorScheme rewrites the live colours and notifies once per change', () => {
  let calls = 0
  const off = subscribeColorScheme(() => calls++)
  applyColorScheme('light')
  applyColorScheme('light')
  expect(getColorScheme()).toBe('light')
  expect(colors.bgBase).toBe(palettes.light.bgBase)
  applyColorScheme('dark')
  expect(colors.bgBase).toBe(palettes.dark.bgBase)
  expect(calls).toBe(2)
  off()
})
