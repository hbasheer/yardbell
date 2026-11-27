import { hasMods, keyBytes, type KeyName, type Mods } from './keys'

export type KeyDef = {
  id: string
  label: string
  a11y: string
  bytes: string
  key?: KeyName | ' '
  repeatable?: boolean
}

const ctrl = (letter: string, a11y: string): KeyDef => ({
  id: `ctrl${letter.toUpperCase()}`,
  label: `Ctrl+${letter.toUpperCase()}`,
  a11y,
  bytes: String.fromCharCode(letter.toUpperCase().charCodeAt(0) & 0x1f)
})

export const KEY_DEFS: KeyDef[] = [
  { id: 'escape', label: 'Esc', a11y: 'Escape', bytes: '\x1b', key: 'esc' },
  { id: 'tab', label: 'Tab', a11y: 'Tab', bytes: '\t', key: 'tab' }
]

export const KEY_DEFS_AFTER_LATCHES: KeyDef[] = [
  { id: 'enter', label: 'Enter', a11y: 'Enter', bytes: '\r', key: 'enter' },
  { id: 'shiftTab', label: 'Shift+Tab', a11y: 'Shift Tab', bytes: '\x1b[Z' },
  { id: 'space', label: 'Space', a11y: 'Space', bytes: ' ', key: ' ' },
  { id: 'backspace', label: '⌫', a11y: 'Backspace', bytes: '\x7f', key: 'bksp', repeatable: true },
  { id: 'delete', label: 'Del', a11y: 'Forward delete', bytes: '\x1b[3~', key: 'del', repeatable: true },
  { id: 'arrowUp', label: '↑', a11y: 'Arrow up', bytes: '\x1b[A', key: 'up', repeatable: true },
  { id: 'arrowDown', label: '↓', a11y: 'Arrow down', bytes: '\x1b[B', key: 'down', repeatable: true },
  { id: 'arrowLeft', label: '←', a11y: 'Arrow left', bytes: '\x1b[D', key: 'left', repeatable: true },
  { id: 'arrowRight', label: '→', a11y: 'Arrow right', bytes: '\x1b[C', key: 'right', repeatable: true },
  ctrl('c', 'Interrupt'),
  ctrl('d', 'Send end of file'),
  ctrl('l', 'Clear screen'),
  ctrl('z', 'Suspend process'),
  ctrl('r', 'Reverse search'),
  ctrl('a', 'Start of line'),
  ctrl('e', 'End of line'),
  ctrl('w', 'Delete word backward'),
  ctrl('u', 'Clear line before cursor')
]

export function defBytes(def: KeyDef, mods: Mods): string {
  if (!hasMods(mods)) return def.bytes
  if (def.key) return keyBytes(def.key, mods)
  return (mods.alt ? '\x1b' : '') + def.bytes
}
