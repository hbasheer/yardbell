import type { ReactNode } from 'react'
import { Animated, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { NAV_BAR_BUTTON_SIZE } from './NavBarButton'
import { colors, pressedStyle, spacing, themedStyleSheet, useColorScheme } from './theme'
import { useReducedMotionEnabled } from './useReducedMotionEnabled'
import { useWorkingSweep } from './useWorkingMotion'

export const NAV_BAR_HEIGHT = 52

type NavBarProps = {
  leading?: ReactNode
  title?: string
  titleLeading?: ReactNode
  subtitle?: ReactNode
  center?: ReactNode
  trailing?: ReactNode
  accessory?: ReactNode
  style?: StyleProp<ViewStyle>
  titleOpacity?: Animated.AnimatedInterpolation<number>
  dividerOpacity?: Animated.AnimatedInterpolation<number>
  refreshing?: boolean
}

export function NavBar({
  leading,
  title,
  titleLeading,
  subtitle,
  center,
  trailing,
  accessory,
  style,
  titleOpacity,
  dividerOpacity,
  refreshing = false
}: NavBarProps) {
  useColorScheme()
  return (
    <View style={[styles.chrome, dividerOpacity && styles.chromeWithoutDivider, style]}>
      <View style={styles.bar}>
        <View style={styles.side}>{leading}</View>
        <Animated.View style={[styles.center, titleOpacity && { opacity: titleOpacity }]}>
          {center ?? (
            <>
              {title !== undefined && titleLeading ? (
                <View style={styles.titleRow}>
                  {titleLeading}
                  <Text style={[styles.title, styles.titleButtonText]} numberOfLines={1} accessibilityRole="header">
                    {title}
                  </Text>
                </View>
              ) : title !== undefined ? (
                <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
                  {title}
                </Text>
              ) : null}
              {subtitle !== undefined ? (
                typeof subtitle === 'string' ? (
                  <Text style={styles.subtitle} numberOfLines={1}>
                    {subtitle}
                  </Text>
                ) : (
                  <View style={styles.subtitleRow}>{subtitle}</View>
                )
              ) : null}
            </>
          )}
        </Animated.View>
        <View style={[styles.side, styles.trailing]}>{trailing}</View>
      </View>
      {accessory !== undefined && accessory !== null ? <View style={styles.accessory}>{accessory}</View> : null}
      {dividerOpacity ? <Animated.View pointerEvents="none" style={[styles.divider, { opacity: dividerOpacity }]} /> : null}
      {refreshing ? <NavBarRefreshLine /> : null}
    </View>
  )
}

export function NavBarRefreshLine() {
  useColorScheme()
  const reducedMotion = useReducedMotionEnabled()
  const sweep = useWorkingSweep(reducedMotion === false)
  if (reducedMotion === null) return null
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.refreshTrack}
    >
      <Animated.View
        onLayout={sweep.onLayout}
        style={[styles.refreshSegment, reducedMotion ? styles.refreshSegmentStill : sweep.style]}
      />
    </View>
  )
}

export function NavBarTitleButton({
  title,
  subtitle,
  onPress,
  accessibilityLabel
}: {
  title: string
  subtitle?: string
  onPress: () => void
  accessibilityLabel: string
}) {
  useColorScheme()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.titleButton, pressed && pressedStyle]}
    >
      <View style={styles.titleButtonRow}>
        <Text style={[styles.title, styles.titleButtonText]} numberOfLines={1}>
          {title}
        </Text>
        <ChevronDown size={14} color={colors.textSecondary} strokeWidth={2.2} />
      </View>
      {subtitle !== undefined ? (
        <Text style={styles.subtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
    </Pressable>
  )
}

export function NavBarSubtitleText({ children }: { children: ReactNode }) {
  useColorScheme()
  return (
    <Text style={styles.subtitle} numberOfLines={1}>
      {children}
    </Text>
  )
}

const styles = themedStyleSheet(() => ({
  chrome: {
    backgroundColor: colors.bgBase,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  bar: {
    height: NAV_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md
  },
  accessory: { paddingBottom: spacing.sm },
  chromeWithoutDivider: { borderBottomColor: 'transparent' },
  divider: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: -StyleSheet.hairlineWidth,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle
  },
  refreshTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: -StyleSheet.hairlineWidth,
    height: 2,
    overflow: 'hidden'
  },
  refreshSegment: { width: '28%', height: '100%', borderRadius: 1, backgroundColor: colors.textSecondary },
  refreshSegmentStill: { width: '100%', opacity: 0.45 },
  side: {
    flex: 1,
    flexBasis: 0,
    minWidth: NAV_BAR_BUTTON_SIZE * 2 + spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  trailing: { justifyContent: 'flex-end' },
  center: { flexShrink: 1, maxWidth: '62%', alignItems: 'center' },
  title: { color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, maxWidth: '100%' },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5, minWidth: 0 },
  subtitle: { color: colors.textSecondary, fontSize: 12, flexShrink: 1 },
  titleButton: { alignItems: 'center', minHeight: 44, justifyContent: 'center', maxWidth: '100%' },
  titleButtonRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, maxWidth: '100%' },
  titleButtonText: { flexShrink: 1 }
}))
