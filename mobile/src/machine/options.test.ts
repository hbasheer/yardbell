import { describe, expect, test } from 'vitest'
import { DEFAULT_OPTIONS, activeOptionCount, collapseKey, parseCollapsed, parseOptions, toggleCollapsed } from './options'

describe('machine options', () => {
  test('defaults when nothing is stored or the value is damaged', () => {
    expect(parseOptions(null)).toEqual(DEFAULT_OPTIONS)
    expect(parseOptions('{nope')).toEqual(DEFAULT_OPTIONS)
    expect(parseOptions('null')).toEqual(DEFAULT_OPTIONS)
    expect(parseOptions('{"groupBy":"machine","showStopped":"yes"}')).toEqual(DEFAULT_OPTIONS)
  })

  test('reads a stored choice', () => {
    expect(parseOptions('{"groupBy":"agent","showStopped":false}')).toEqual({ groupBy: 'agent', showStopped: false })
  })

  test('badge counts the options that differ from the default', () => {
    expect(activeOptionCount(DEFAULT_OPTIONS)).toBe(0)
    expect(activeOptionCount({ groupBy: 'status', showStopped: true })).toBe(1)
    expect(activeOptionCount({ groupBy: 'agent', showStopped: false })).toBe(2)
  })
})

describe('collapsed sections', () => {
  test('parses a stored list and ignores junk', () => {
    expect([...parseCollapsed('["a","b",3]')]).toEqual(['a', 'b'])
    expect(parseCollapsed('{"a":1}').size).toBe(0)
    expect(parseCollapsed('oops').size).toBe(0)
    expect(parseCollapsed(null).size).toBe(0)
  })

  test('toggle adds then removes without mutating', () => {
    const empty = new Set<string>()
    const one = toggleCollapsed(empty, 'a')
    expect(one.has('a')).toBe(true)
    expect(empty.size).toBe(0)
    expect(toggleCollapsed(one, 'a').has('a')).toBe(false)
  })

  test('keys differ by server, machine and grouping', () => {
    const base = collapseKey('s', 'hp', 'project', '/r')
    expect(collapseKey('t', 'hp', 'project', '/r')).not.toBe(base)
    expect(collapseKey('s', 'nas', 'project', '/r')).not.toBe(base)
    expect(collapseKey('s', 'hp', 'status', '/r')).not.toBe(base)
  })
})
