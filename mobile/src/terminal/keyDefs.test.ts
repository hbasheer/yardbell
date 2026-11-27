import { describe, expect, test } from 'vitest'
import { defBytes, KEY_DEFS, KEY_DEFS_AFTER_LATCHES } from './keyDefs'
import { NO_MODS } from './keys'

const all = [...KEY_DEFS, ...KEY_DEFS_AFTER_LATCHES]
const byId = (id: string) => all.find((d) => d.id === id)!

describe('key definitions', () => {
  test('order of the row', () => {
    expect(KEY_DEFS.map((d) => d.label)).toEqual(['Esc', 'Tab'])
    expect(KEY_DEFS_AFTER_LATCHES.map((d) => d.label)).toEqual([
      'Enter', 'Shift+Tab', 'Space', '⌫', 'Del', '↑', '↓', '←', '→',
      'Ctrl+C', 'Ctrl+D', 'Ctrl+L', 'Ctrl+Z', 'Ctrl+R', 'Ctrl+A', 'Ctrl+E', 'Ctrl+W', 'Ctrl+U'
    ])
  })

  test('bytes with no latch held', () => {
    const bytes = Object.fromEntries(all.map((d) => [d.id, defBytes(d, NO_MODS)]))
    expect(bytes).toMatchObject({
      escape: '\x1b',
      tab: '\t',
      enter: '\r',
      shiftTab: '\x1b[Z',
      space: ' ',
      backspace: '\x7f',
      delete: '\x1b[3~',
      arrowUp: '\x1b[A',
      arrowDown: '\x1b[B',
      arrowLeft: '\x1b[D',
      arrowRight: '\x1b[C',
      ctrlC: '\x03',
      ctrlD: '\x04',
      ctrlL: '\x0c',
      ctrlZ: '\x1a',
      ctrlR: '\x12',
      ctrlA: '\x01',
      ctrlE: '\x05',
      ctrlW: '\x17',
      ctrlU: '\x15'
    })
  })

  test('latches change what the next key sends', () => {
    expect(defBytes(byId('arrowLeft'), { ...NO_MODS, ctrl: true })).toBe('\x1b[1;5D')
    expect(defBytes(byId('tab'), { ...NO_MODS, shift: true })).toBe('\x1b[Z')
    expect(defBytes(byId('enter'), { ...NO_MODS, alt: true })).toBe('\x1b\r')
    expect(defBytes(byId('space'), { ...NO_MODS, ctrl: true })).toBe('\x00')
    expect(defBytes(byId('ctrlC'), { ...NO_MODS, alt: true })).toBe('\x1b\x03')
    expect(defBytes(byId('delete'), { ...NO_MODS, shift: true })).toBe('\x1b[3;2~')
  })

  test('only the movement and delete keys repeat', () => {
    expect(all.filter((d) => d.repeatable).map((d) => d.id)).toEqual([
      'backspace', 'delete', 'arrowUp', 'arrowDown', 'arrowLeft', 'arrowRight'
    ])
  })
})
