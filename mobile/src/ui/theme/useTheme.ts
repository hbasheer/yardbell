import { useSyncExternalStore } from 'react'
import { palettes, type ColorScheme, type Palette } from './palette'
import { getColorScheme, subscribeColorScheme } from './scheme'

export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribeColorScheme, getColorScheme)
}

export function useTheme(): Palette {
  return palettes[useColorScheme()]
}
