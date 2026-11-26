import { describe, expect, test } from 'vitest'
import { normalizeAddress, parsePairingLink } from './link'

describe('parsePairingLink', () => {
  test('reads server and code', () => {
    expect(
      parsePairingLink('yardbell://pair?server=http%3A%2F%2F100.64.0.10%3A4000&code=Ab12')
    ).toEqual({ address: 'http://100.64.0.10:4000', code: 'Ab12' })
  })

  test.each([
    'yardbell://pair?code=abc',
    'yardbell://pair?server=http%3A%2F%2F1.2.3.4&code=../x',
    'yardbell://pair?server=ftp%3A%2F%2F1.2.3.4&code=abc',
    'yardbell://other?server=http%3A%2F%2F1.2.3.4&code=abc',
    'yardbell://pair?server=http%3A%2F%2F1.2.3.4',
    'yardbell://pair?server=http%3A%2F%2F1.2.3.4&code=',
    'https://x',
    'https://example.com/?server=x&code=y',
    'not a url'
  ])('rejects %s', (bad) => {
    expect(() => parsePairingLink(bad)).toThrow('That is not a Yardbell pairing code')
  })

  test('rejects a code over 64 characters', () => {
    const code = 'a'.repeat(65)
    expect(() =>
      parsePairingLink(`yardbell://pair?server=http%3A%2F%2F1.2.3.4&code=${code}`)
    ).toThrow('That is not a Yardbell pairing code')
  })
})

describe('normalizeAddress', () => {
  test('adds the scheme and trims', () => {
    expect(normalizeAddress('100.64.0.10:4000')).toBe('http://100.64.0.10:4000')
    expect(normalizeAddress(' https://box.ts.net/ ')).toBe('https://box.ts.net')
  })

  test('rejects paths and empty input', () => {
    expect(() => normalizeAddress('http://x/path')).toThrow()
    expect(() => normalizeAddress('')).toThrow()
  })
})
