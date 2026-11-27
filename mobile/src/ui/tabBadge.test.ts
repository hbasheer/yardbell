import { expect, test } from 'vitest'
import { tabBadgeLabel } from './tabBadge'

test('counts up to 99 show as they are', () => {
  expect(tabBadgeLabel(1)).toBe('1')
  expect(tabBadgeLabel(99)).toBe('99')
})

test('counts above 99 are capped', () => {
  expect(tabBadgeLabel(100)).toBe('99+')
  expect(tabBadgeLabel(1234)).toBe('99+')
})
