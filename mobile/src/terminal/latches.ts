import type { Mods } from './keys'

export type Latch = 'off' | 'once' | 'locked'
export type Latches = Readonly<Record<keyof Mods, Latch>>
export type LatchName = keyof Mods

export const NO_LATCHES: Latches = { shift: 'off', ctrl: 'off', alt: 'off' }

export const DOUBLE_TAP_MS = 350

export function tapLatch(latches: Latches, name: LatchName, doubleTap: boolean): Latches {
  const next: Latch = doubleTap ? 'locked' : latches[name] === 'off' ? 'once' : 'off'
  return { ...latches, [name]: next }
}

export function modsOf(latches: Latches): Mods {
  return { shift: latches.shift !== 'off', ctrl: latches.ctrl !== 'off', alt: latches.alt !== 'off' }
}

export function consumeLatches(latches: Latches): Latches {
  const release = (latch: Latch): Latch => (latch === 'once' ? 'off' : latch)
  return { shift: release(latches.shift), ctrl: release(latches.ctrl), alt: release(latches.alt) }
}
