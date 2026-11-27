import { describe, expect, test } from 'vitest'
import { keyBytes, NO_MODS, withMods } from './keys'

const none = NO_MODS
const ctrl = { ...NO_MODS, ctrl: true }
const alt = { ...NO_MODS, alt: true }
const shift = { ...NO_MODS, shift: true }

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
    expect(keyBytes('end', { ...NO_MODS, ctrl: true, alt: true })).toBe('\x1b[1;7F')
  })

  test('shift', () => {
    expect(keyBytes('tab', shift)).toBe('\x1b[Z')
    expect(keyBytes('up', shift)).toBe('\x1b[1;2A')
    expect(keyBytes('up', { ...NO_MODS, shift: true, ctrl: true })).toBe('\x1b[1;6A')
    expect(keyBytes('a', shift)).toBe('A')
    expect(keyBytes('a', { ...NO_MODS, shift: true, ctrl: true })).toBe('\x01')
  })

  test('backspace and delete', () => {
    expect(keyBytes('bksp', none)).toBe('\x7f')
    expect(keyBytes('del', none)).toBe('\x1b[3~')
    expect(keyBytes('del', ctrl)).toBe('\x1b[3;5~')
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
