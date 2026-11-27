import { createContext, useContext, type ComponentType } from 'react'
import { Pressable, Text, View } from 'react-native'
import { colors, feedback, fixedColors, radii, themedStyleSheet, useColorScheme } from './theme'

export const NAV_BAR_BUTTON_SIZE = 36

export const NavBarButtonOnSheetContext = createContext(false)

type IconProps = { size?: number; color?: string; strokeWidth?: number }

type NavBarButtonProps = {
  icon: ComponentType<IconProps>
  accessibilityLabel: string
  onPress: () => void
  active?: boolean
  disabled?: boolean
  iconColor?: string
  badge?: { count: number; color: string }
}

export function NavBarButton({
  icon: Icon,
  accessibilityLabel,
  onPress,
  active = false,
  disabled = false,
  iconColor,
  badge
}: NavBarButtonProps) {
  useColorScheme()
  const onSheet = useContext(NavBarButtonOnSheetContext)
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        onSheet && styles.onSheet,
        active && styles.active,
        pressed && styles.pressed,
        disabled && styles.disabled
      ]}
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, selected: active }}
    >
      <Icon size={18} color={active ? colors.bgBase : (iconColor ?? colors.textPrimary)} strokeWidth={2.1} />
      {badge && badge.count > 0 ? (
        <View style={[styles.badge, { backgroundColor: badge.color }]}>
          <Text style={styles.badgeText}>{badge.count > 99 ? '99+' : badge.count}</Text>
        </View>
      ) : null}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  button: {
    width: NAV_BAR_BUTTON_SIZE,
    height: NAV_BAR_BUTTON_SIZE,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  onSheet: { backgroundColor: colors.cardPillFill },
  active: { backgroundColor: colors.surfaceBright },
  pressed: { opacity: feedback.pressedOpacity },
  disabled: { opacity: feedback.disabledOpacity },
  badge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.bgBase
  },
  badgeText: { fontSize: 10, fontWeight: '700', color: fixedColors.white, lineHeight: 12 }
}))
