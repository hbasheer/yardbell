import { describe, expect, test } from 'vitest'
import { keyBytes, withMods } from './keys'

const none = { ctrl: false, alt: false }
const ctrl = { ctrl: true, alt: false }
const alt = { ctrl: false, alt: true }

describe('keyBytes', () => {
  test('cursor keys', () => {
    expect(keyBytes('up', none)).toBe('\x1b[A')
    expect(keyBytes('down', none)).toBe('\x1b[B')
    expect(keyBytes('right', none)).toBe('\x1b[C')
    expect(keyBytes('left', none)).toBe('\x1b[D')
    expect(keyBytes('home', none)).toBe('\x1b[H')
    expect(keyBytes('end', none)).toBe('\x1b[F')
  })

  test('modified cursor keys carry the xterm parameter', () => {
    expect(keyBytes('up', ctrl)).toBe('\x1b[1;5A')
    expect(keyBytes('left', alt)).toBe('\x1b[1;3D')
    expect(keyBytes('end', { ctrl: true, alt: true })).toBe('\x1b[1;7F')
  })

  test('page keys', () => {
    expect(keyBytes('pgup', none)).toBe('\x1b[5~')
    expect(keyBytes('pgdn', ctrl)).toBe('\x1b[6;5~')
  })

  test('plain keys', () => {
    expect(keyBytes('esc', none)).toBe('\x1b')
    expect(keyBytes('esc', ctrl)).toBe('\x1b')
    expect(keyBytes('tab', none)).toBe('\t')
    expect(keyBytes('enter', none)).toBe('\r')
    expect(keyBytes('enter', alt)).toBe('\x1b\r')
  })

  test('ctrl with a letter', () => {
    expect(keyBytes('c', ctrl)).toBe('\x03')
    expect(keyBytes('C', ctrl)).toBe('\x03')
    expect(keyBytes('c', alt)).toBe('\x1bc')
    expect(keyBytes(' ', ctrl)).toBe('\x00')
    expect(keyBytes('?', ctrl)).toBe('\x7f')
  })
})

describe('withMods', () => {
  test('applies armed modifiers to what the keyboard typed', () => {
    expect(withMods('c', ctrl)).toBe('\x03')
    expect(withMods('\x1b[A', ctrl)).toBe('\x1b[1;5A')
    expect(withMods('\x1b[5~', alt)).toBe('\x1b[5;3~')
    expect(withMods('\r', alt)).toBe('\x1b\r')
  })

  test('leaves pastes and other sequences alone', () => {
    expect(withMods('hello', ctrl)).toBeNull()
    expect(withMods('\x1b[<0;1;1M', ctrl)).toBeNull()
  })
})
