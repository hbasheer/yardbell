import type { ComponentType } from 'react'
import { ActivityIndicator, Pressable, Text } from 'react-native'
import { colors, feedback, radii, spacing, themedStyleSheet, useColorScheme } from './theme'

type IconProps = { size?: number; color?: string; strokeWidth?: number }

type ActionButtonProps = {
  label: string
  onPress: () => void
  variant?: 'primary' | 'ghost'
  icon?: ComponentType<IconProps>
  disabled?: boolean
  busy?: boolean
  fullWidth?: boolean
}

export function ActionButton({ label, onPress, variant = 'primary', icon: Icon, disabled = false, busy = false, fullWidth = false }: ActionButtonProps) {
  useColorScheme()
  const primary = variant === 'primary'
  const tint = primary ? colors.bgBase : colors.textSecondary
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      style={({ pressed }) => [
        primary ? styles.primary : styles.ghost,
        fullWidth && styles.fullWidth,
        (pressed || busy) && styles.pressed,
        disabled && styles.disabled
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={tint} /> : Icon ? <Icon size={16} color={tint} strokeWidth={2.1} /> : null}
      <Text style={[styles.label, { color: tint }, primary ? styles.primaryLabel : styles.ghostLabel]}>{label}</Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: 10,
    borderRadius: radii.control,
    backgroundColor: colors.textPrimary
  },
  ghost: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  fullWidth: { alignSelf: 'stretch' },
  pressed: { opacity: feedback.pressedOpacity },
  disabled: { opacity: feedback.disabledOpacity },
  label: { fontSize: 14 },
  primaryLabel: { fontWeight: '600' },
  ghostLabel: { fontWeight: '500' }
}))
