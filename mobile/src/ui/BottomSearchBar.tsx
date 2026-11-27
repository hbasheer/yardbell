import { useEffect, useState, type ComponentType } from 'react'
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { X } from 'lucide-react-native'
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { SearchField } from './SearchField'
import { SHEET_CURVE } from './motion'
import { colors, feedback, fixedColors, radii, spacing, themedStyleSheet, useColorScheme } from './theme'
import { useKeyboardHeight } from './useKeyboardHeight'
import { useReducedMotionEnabled } from './useReducedMotionEnabled'

const FADE_ID = 'bottom-search-bar-fade'
const BUTTON_SIZE = 44
const LEADING_SLIDE_MS = 220

type IconProps = { size?: number; color?: string; strokeWidth?: number }

export type BarButton = {
  icon: ComponentType<IconProps>
  accessibilityLabel: string
  onPress: () => void
  disabled?: boolean
  badge?: number
}

type BottomSearchBarProps = {
  value: string
  onChangeText: (text: string) => void
  placeholder: string
  bottomInset: number
  leading?: BarButton
  primary?: BarButton
  onCoveredHeightChange?: (height: number) => void
  onSubmitEditing?: () => void
  onBlur?: () => void
  onClear?: () => void
  hasSearch?: boolean
  editable?: boolean
  accessibilityLabel?: string
}

export function BottomSearchBar({
  value,
  onChangeText,
  placeholder,
  bottomInset,
  leading,
  primary,
  onCoveredHeightChange,
  onSubmitEditing,
  onBlur,
  onClear,
  hasSearch,
  editable,
  accessibilityLabel
}: BottomSearchBarProps) {
  useColorScheme()
  const keyboardHeight = useKeyboardHeight().height
  const keyboardUp = keyboardHeight > 0
  const [focused, setFocused] = useState(false)
  const [barHeight, setBarHeight] = useState(0)
  const coveredHeight = barHeight + keyboardHeight
  useEffect(() => {
    onCoveredHeightChange?.(coveredHeight)
  }, [coveredHeight, onCoveredHeightChange])
  const searching = focused || keyboardUp || (hasSearch ?? value.trim() !== '')

  const closeSearch = () => {
    if (onClear) onClear()
    else onChangeText('')
    setFocused(false)
    Keyboard.dismiss()
  }

  return (
    <View
      style={[
        styles.bar,
        keyboardUp ? { bottom: keyboardHeight, paddingBottom: spacing.sm } : { paddingBottom: Math.max(bottomInset, spacing.lg) }
      ]}
      onLayout={(event) => setBarHeight(event.nativeEvent.layout.height)}
    >
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Svg width="100%" height="100%">
          <Defs>
            <LinearGradient id={FADE_ID} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={colors.bgBase} stopOpacity={0} />
              <Stop offset="0.45" stopColor={colors.bgBase} stopOpacity={1} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill={`url(#${FADE_ID})`} />
        </Svg>
      </View>
      <View style={styles.row}>
        {leading ? <LeadingSlot button={leading} hidden={searching} /> : null}
        <View style={styles.search}>
          <SearchField
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false)
              onBlur?.()
            }}
            onSubmitEditing={onSubmitEditing}
            showClear={false}
            editable={editable}
            accessibilityLabel={accessibilityLabel}
            style={styles.field}
          />
        </View>
        {searching ? (
          <RoundButton button={{ icon: X, accessibilityLabel: 'Close search', onPress: closeSearch }} />
        ) : primary ? (
          <RoundButton button={primary} emphasis />
        ) : null}
      </View>
    </View>
  )
}

function LeadingSlot({ button, hidden }: { button: BarButton; hidden: boolean }) {
  const reducedMotion = useReducedMotionEnabled()
  const shown = useSharedValue(hidden ? 0 : 1)
  useEffect(() => {
    shown.value = withTiming(hidden ? 0 : 1, {
      duration: reducedMotion === true ? 0 : LEADING_SLIDE_MS,
      easing: Easing.bezier(...SHEET_CURVE)
    })
  }, [hidden, reducedMotion, shown])
  const slotStyle = useAnimatedStyle(
    () => ({ width: shown.value * (BUTTON_SIZE + spacing.sm), opacity: shown.value }),
    [shown]
  )
  return (
    <Animated.View
      style={[styles.leadingSlot, slotStyle]}
      pointerEvents={hidden ? 'none' : 'auto'}
      aria-hidden={hidden}
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
    >
      <RoundButton button={button} />
    </Animated.View>
  )
}

function RoundButton({ button, emphasis = false }: { button: BarButton; emphasis?: boolean }) {
  const { icon: Icon, badge = 0 } = button
  const lit = badge > 0
  return (
    <Pressable
      onPress={button.onPress}
      disabled={button.disabled}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={button.accessibilityLabel}
      accessibilityState={{ disabled: button.disabled === true, selected: lit }}
      style={({ pressed }) => [
        styles.button,
        emphasis && styles.buttonEmphasis,
        lit && styles.buttonLit,
        pressed && styles.pressed,
        button.disabled && styles.disabled
      ]}
    >
      <Icon size={20} color={emphasis ? colors.onCreateActionFill : colors.textPrimary} strokeWidth={2.2} />
      {lit ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  )
}

const shadow = {
  shadowColor: fixedColors.black,
  shadowOpacity: 0.35,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 6 },
  elevation: 6
} as const

const styles = themedStyleSheet(() => ({
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: 36, paddingHorizontal: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  leadingSlot: { marginRight: -spacing.sm },
  search: { flex: 1, minWidth: 0 },
  field: { minHeight: BUTTON_SIZE, borderRadius: radii.pill, ...shadow },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.composerBorder,
    ...shadow
  },
  buttonEmphasis: { backgroundColor: colors.createActionFill, borderColor: 'transparent' },
  buttonLit: { borderColor: colors.textSecondary },
  pressed: { opacity: feedback.pressedOpacity },
  disabled: { opacity: feedback.disabledOpacity },
  badge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentBlue
  },
  badgeText: { color: colors.onAccent, fontSize: 11, fontWeight: '700' }
}))
