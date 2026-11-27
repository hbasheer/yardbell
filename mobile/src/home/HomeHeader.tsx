import type { LucideIcon } from 'lucide-react-native'
import type { ReactNode, RefObject } from 'react'
import { Pressable, Text, View, type HostInstance } from 'react-native'
import { colors, radii, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'

export function HomeHeader({ title, children }: { title: string; children?: ReactNode }) {
  useColorScheme()
  return (
    <View style={styles.header}>
      <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
        {title}
      </Text>
      <View style={styles.actions}>{children}</View>
    </View>
  )
}

export const HeaderIconButton = ({
  icon: Icon,
  label,
  onPress,
  active = false,
  anchorRef
}: {
  icon: LucideIcon
  label: string
  onPress: () => void
  active?: boolean
  anchorRef?: RefObject<HostInstance | null>
}) => {
  useColorScheme()
  return (
    <Pressable
      ref={anchorRef}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.button, (pressed || active) && styles.buttonActive]}
    >
      <Icon size={21} color={colors.textSecondary} strokeWidth={2} />
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  header: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: spacing.lg + spacing.xs,
    paddingRight: spacing.sm
  },
  title: { flex: 1, fontSize: 22, fontWeight: '700', letterSpacing: -0.4, color: colors.textPrimary },
  actions: { flexDirection: 'row', alignItems: 'center' },
  button: { width: 44, height: 44, borderRadius: radii.control, alignItems: 'center', justifyContent: 'center' },
  buttonActive: { backgroundColor: colors.bgRaised }
}))
