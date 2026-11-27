import { Text } from 'react-native'
import { resourceSummary, resourcesOf } from '@/state/resources'
import type { MachineRow } from '@/state/views'
import { levelColor } from '@/ui/resourceColors'
import { colors, themedStyleSheet, useColorScheme } from '@/ui/theme'

export function ResourceLine({ row }: { row: MachineRow }) {
  useColorScheme()
  const parts = resourceSummary(resourcesOf(row.status === 'up', row.health))
  if (parts.length === 0) return null
  return (
    <Text style={styles.line} numberOfLines={1}>
      {parts.map((part, index) => (
        <Text key={part.text} style={{ color: levelColor(part.level, colors.textSecondary) }}>
          {index > 0 ? ' · ' : ''}
          {part.text}
        </Text>
      ))}
    </Text>
  )
}

const styles = themedStyleSheet(() => ({
  line: { fontSize: 12, color: colors.textSecondary, fontVariant: ['tabular-nums'] }
}))
