import { Pressable, Text, View } from 'react-native'
import { colors, radii, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'

export type Segment<T extends string> = { id: T; label: string; count?: number }

export function Segmented<T extends string>({
  segments,
  value,
  onChange
}: {
  segments: Segment<T>[]
  value: T
  onChange: (id: T) => void
}) {
  useColorScheme()
  return (
    <View style={styles.track} accessibilityRole="tablist">
      {segments.map((segment) => {
        const selected = segment.id === value
        return (
          <Pressable
            key={segment.id}
            style={[styles.segment, selected && styles.selected]}
            onPress={() => onChange(segment.id)}
            accessibilityRole="tab"
            accessibilityLabel={segment.count === undefined ? segment.label : `${segment.label}, ${segment.count}`}
            accessibilityState={{ selected }}
          >
            <Text style={[styles.label, selected && styles.labelSelected]} numberOfLines={1}>
              {segment.label}
              {segment.count === undefined ? null : <Text style={styles.count}>{`  ${segment.count}`}</Text>}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  track: {
    flexDirection: 'row',
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    padding: 3,
    borderRadius: radii.control,
    backgroundColor: colors.sheetGroup
  },
  segment: { flex: 1, minHeight: 34, alignItems: 'center', justifyContent: 'center', borderRadius: radii.control - 3 },
  selected: { backgroundColor: colors.bgRaised },
  label: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  labelSelected: { color: colors.textPrimary },
  count: { fontWeight: '500', color: colors.textMuted, fontVariant: ['tabular-nums'] }
}))
