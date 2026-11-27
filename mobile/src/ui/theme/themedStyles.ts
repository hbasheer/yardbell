import { StyleSheet, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native'
import type { ColorScheme } from './palette'
import { getColorScheme } from './scheme'

type NamedStyles<T> = { [P in keyof T]: ViewStyle | TextStyle | ImageStyle }

export function themedStyles<T extends Record<string, unknown>>(create: () => T): T {
  const built = new Map<ColorScheme, T>()
  const current = (): T => {
    const scheme = getColorScheme()
    let styles = built.get(scheme)
    if (styles === undefined) {
      styles = create()
      built.set(scheme, styles)
    }
    return styles
  }
  const live = { ...current() }
  for (const key of Object.keys(live)) {
    Object.defineProperty(live, key, { enumerable: true, get: () => current()[key] })
  }
  return live
}

export function themedStyleSheet<T extends NamedStyles<T>>(create: () => T): T {
  return themedStyles(() => StyleSheet.create(create()))
}
