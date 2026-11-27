import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { DisclosureChevron } from './DisclosureChevron'
import { LIST_ROW_PADDING } from './ListGroup'
import { colors, spacing, themedStyleSheet, useColorScheme } from './theme'

type SectionHeaderProps = {
  title: string
  icon?: ReactNode
  trailing?: ReactNode
  expanded?: boolean
  onToggle?: () => void
  first?: boolean
}

export function SectionHeader({ title, icon, trailing, expanded, onToggle, first = false }: SectionHeaderProps) {
  useColorScheme()
  const label = (
    <>
      {icon}
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.spacer} />
      {typeof trailing === 'string' ? <Text style={styles.title}>{trailing}</Text> : trailing}
    </>
  )
  if (onToggle === undefined) {
    return <View style={[styles.header, first && styles.first]}>{label}</View>
  }
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ expanded: expanded === true }}
      style={({ pressed }) => [styles.header, styles.toggle, first && styles.first, pressed && styles.pressed]}
    >
      {label}
      <DisclosureChevron expanded={expanded === true} collapsedDeg={-90} expandedDeg={0}>
        <ChevronDown size={15} color={colors.textMuted} strokeWidth={2.2} />
      </DisclosureChevron>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingTop: spacing.lg,
    paddingBottom: 6
  },
  toggle: { minHeight: 44, paddingBottom: spacing.xs },
  first: { paddingTop: spacing.xs },
  pressed: { opacity: 0.6 },
  title: { fontSize: 13, fontWeight: '500', color: colors.textSecondary, flexShrink: 1 },
  spacer: { flex: 1 }
}))
