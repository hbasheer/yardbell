export type KeyName = 'esc' | 'tab' | 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pgup' | 'pgdn' | 'enter'

export type Mods = { ctrl: boolean; alt: boolean }

type Key = { csi: string } | { tilde: number } | { name: 'esc' | 'tab' | 'enter' | 'bksp' } | { char: string }

const NAMED: Record<KeyName, Key> = {
  esc: { name: 'esc' },
  tab: { name: 'tab' },
  enter: { name: 'enter' },
  up: { csi: 'A' },
  down: { csi: 'B' },
  right: { csi: 'C' },
  left: { csi: 'D' },
  home: { csi: 'H' },
  end: { csi: 'F' },
  pgup: { tilde: 5 },
  pgdn: { tilde: 6 }
}

function ctrlChar(c: string): string {
  if (c === ' ' || c === '@' || c === '2') return '\x00'
  if (c === '?' || c === '8') return '\x7f'
  if (c === '/') return '\x1f'
  if (c >= '3' && c <= '7') return String.fromCharCode(c.charCodeAt(0) - 24)
  const n = c.charCodeAt(0)
  return c.length === 1 && n >= 64 && n <= 126 ? String.fromCharCode(n & 0x1f) : c
}

function encode(k: Key, m: Mods): string {
  const p = 1 + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0)
  if ('csi' in k) return p > 1 ? `\x1b[1;${p}${k.csi}` : `\x1b[${k.csi}`
  if ('tilde' in k) return p > 1 ? `\x1b[${k.tilde};${p}~` : `\x1b[${k.tilde}~`
  let s: string
  if ('char' in k) s = m.ctrl ? ctrlChar(k.char) : k.char
  else if (k.name === 'tab') s = '\t'
  else if (k.name === 'enter') s = '\r'
  else if (k.name === 'esc') s = '\x1b'
  else s = m.ctrl ? '\x08' : '\x7f'
  return m.alt ? `\x1b${s}` : s
}

const isKeyName = (key: string): key is KeyName => Object.prototype.hasOwnProperty.call(NAMED, key)

export function keyBytes(key: KeyName | (string & {}), mods: Mods): string {
  return encode(isKeyName(key) ? NAMED[key] : { char: key }, mods)
}

function typedKey(d: string): Key | null {
  if (d === '\r') return { name: 'enter' }
  if (d === '\t') return { name: 'tab' }
  if (d === '\x7f' || d === '\b') return { name: 'bksp' }
  if (d === '\x1b') return { name: 'esc' }
  let m = /^\x1b[[O]([ABCDHF])$/.exec(d)
  if (m) return { csi: m[1] }
  m = /^\x1b\[(\d+)~$/.exec(d)
  if (m) return { tilde: Number(m[1]) }
  return [...d].length === 1 && d >= ' ' ? { char: d } : null
}

// A paste or a mouse report is not one key, so it gives null and goes through untouched.
export function withMods(d: string, mods: Mods): string | null {
  const key = typedKey(d)
  return key ? encode(key, mods) : null
}
