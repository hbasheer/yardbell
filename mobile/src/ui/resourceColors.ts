import type { Level } from '@/state/resources'
import { colors } from './theme'

export function levelColor(level: Level, normal: string = colors.textPrimary): string {
  if (level === 'bad') return colors.statusRed
  if (level === 'warn') return colors.statusAmber
  return normal
}
