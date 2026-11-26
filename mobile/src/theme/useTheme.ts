import { useColorScheme } from 'react-native'
import { colors } from './colors'

export function useTheme() {
  return colors[useColorScheme() === 'light' ? 'light' : 'dark']
}
