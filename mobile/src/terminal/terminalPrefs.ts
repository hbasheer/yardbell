import AsyncStorage from '@react-native-async-storage/async-storage'
import { useEffect, useState } from 'react'
import { DEFAULT_TEXT_SIZE, parseTextSize } from '../session/chrome'

export const FONT_FAMILIES = [
  { id: 'geist-mono', label: 'Geist Mono' },
  { id: 'jetbrains-mono', label: 'JetBrains Mono' },
  { id: 'system', label: 'System monospace' }
] as const

export type FontFamilyId = (typeof FONT_FAMILIES)[number]['id']
export type TerminalPrefs = { fontFamily: FontFamilyId; fontSize: number }

export const DEFAULT_PREFS: TerminalPrefs = { fontFamily: 'geist-mono', fontSize: DEFAULT_TEXT_SIZE }

const SIZE_KEY = 'yardbell:terminal-text-size'
const FAMILY_KEY = 'yardbell:terminal-font-family'

export function parseFontFamily(raw: string | null): FontFamilyId {
  return FONT_FAMILIES.find((f) => f.id === raw)?.id ?? DEFAULT_PREFS.fontFamily
}

let current: TerminalPrefs = DEFAULT_PREFS
let loaded: Promise<void> | null = null
const listeners = new Set<(prefs: TerminalPrefs) => void>()

function publish(next: TerminalPrefs) {
  current = next
  for (const listener of listeners) listener(next)
}

function load(): Promise<void> {
  loaded ??= Promise.all([AsyncStorage.getItem(SIZE_KEY), AsyncStorage.getItem(FAMILY_KEY)])
    .then(([size, family]) => publish({ fontSize: parseTextSize(size), fontFamily: parseFontFamily(family) }))
    .catch((error) => console.error('Could not read the terminal settings', error))
  return loaded
}

export function setFontSize(size: number): void {
  publish({ ...current, fontSize: parseTextSize(String(size)) })
  AsyncStorage.setItem(SIZE_KEY, String(current.fontSize)).catch((error) => console.error('Could not save the text size', error))
}

export function setFontFamily(family: FontFamilyId): void {
  publish({ ...current, fontFamily: parseFontFamily(family) })
  AsyncStorage.setItem(FAMILY_KEY, current.fontFamily).catch((error) => console.error('Could not save the font', error))
}

export function useTerminalPrefs(): TerminalPrefs & { setFontSize: typeof setFontSize; setFontFamily: typeof setFontFamily } {
  const [prefs, setPrefs] = useState(current)
  useEffect(() => {
    listeners.add(setPrefs)
    setPrefs(current)
    load()
    return () => {
      listeners.delete(setPrefs)
    }
  }, [])
  return { ...prefs, setFontSize, setFontFamily }
}
