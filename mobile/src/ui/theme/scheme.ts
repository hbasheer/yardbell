import { palettes, type ColorScheme, type Palette } from './palette'

export type AppearancePreference = 'system' | 'light' | 'dark'

export function resolveScheme(
  preference: AppearancePreference,
  systemScheme: ColorScheme | 'unspecified' | null | undefined
): ColorScheme {
  if (preference !== 'system') return preference
  return systemScheme === 'light' ? 'light' : 'dark'
}

export function isAppearancePreference(value: unknown): value is AppearancePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

export const colors: Palette = { ...palettes.dark }

let currentScheme: ColorScheme = 'dark'
const listeners = new Set<() => void>()

export function getColorScheme(): ColorScheme {
  return currentScheme
}

export function applyColorScheme(scheme: ColorScheme): void {
  if (scheme === currentScheme) return
  currentScheme = scheme
  Object.assign(colors, palettes[scheme])
  for (const listener of listeners) listener()
}

export function subscribeColorScheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
