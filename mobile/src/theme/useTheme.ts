import { useColorScheme } from '../ui/theme/useTheme'
import { colors } from './colors'

export function useTheme() {
  return colors[useColorScheme()]
}
