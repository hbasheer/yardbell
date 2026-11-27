import { Platform } from 'react-native'

export const spacing = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const

export const radii = {
  control: 12,
  pill: 999,
  surface: 16,
  floating: 24,
  tile: 10,
  mark: 4
} as const

export function concentricRadius(parentRadius: number, inset: number): number {
  return Math.max(radii.mark, parentRadius - inset)
}

export const typography = {
  titleSize: 18,
  bodySize: 14,
  metaSize: 12,
  monoFamily: Platform.select({ web: 'ui-monospace, SFMono-Regular, Menlo, monospace', default: 'monospace' })
} as const

export const feedback = { pressedOpacity: 0.7, disabledOpacity: 0.4 } as const

export const pressedStyle = { opacity: feedback.pressedOpacity } as const

export const fixedColors = { black: '#000000', white: '#ffffff', scrim: 'rgba(0, 0, 0, 0.55)' } as const

export const agentColors = {
  working: '#eab308',
  done: '#10b981',
  failed: '#ef4444',
  idle: 'rgba(115, 115, 115, 0.4)'
} as const
