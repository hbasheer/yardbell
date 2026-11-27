import { Pressable, Text, View } from 'react-native'
import { colors, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'

export function HomeSectionHeading({
  title,
  count,
  first = false,
  link
}: {
  title: string
  count?: number
  first?: boolean
  link?: { label: string; onPress: () => void }
}) {
  useColorScheme()
  return (
    <View style={[styles.row, first && styles.first]}>
      <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
        {title}
        {count === undefined ? null : <Text style={styles.count}>{`  ${count}`}</Text>}
      </Text>
      {link ? (
        <Pressable accessibilityRole="link" onPress={link.onPress} hitSlop={8}>
          <Text style={styles.link}>{link.label}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.xs,
    marginTop: 20,
    marginBottom: 7
  },
  first: { marginTop: spacing.xs },
  title: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  count: { fontWeight: '500', color: colors.textMuted, fontVariant: ['tabular-nums'] },
  link: { fontSize: 14, fontWeight: '500', color: colors.accentBlue }
}))
