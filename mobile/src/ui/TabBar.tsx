import { useEffect, useState } from 'react'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated'
import type { LucideIcon } from 'lucide-react-native'
import { tabBadgeLabel } from './tabBadge'
import { colors, fixedColors, radii, spacing, themedStyleSheet, useColorScheme } from './theme'
import { useReducedMotionEnabled } from './useReducedMotionEnabled'

export const TAB_BAR_HEIGHT = 52
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1)

export type TabBarItem = { id: string; label: string; icon: LucideIcon; badge?: number }

export function TabBar(props: {
  tabs: readonly TabBarItem[]
  active: string
  bottomInset: number
  onSelect: (id: string) => void
}) {
  useColorScheme()
  return (
    <View
      style={[styles.bar, { paddingBottom: Math.max(props.bottomInset, spacing.lg) }]}
      accessibilityRole={Platform.OS === 'ios' ? 'tabbar' : 'tablist'}
    >
      {props.tabs.map((tab) => (
        <TabButton
          key={tab.id}
          icon={tab.icon}
          label={tab.label}
          selected={tab.id === props.active}
          badge={tab.badge ?? 0}
          onPress={() => props.onSelect(tab.id)}
        />
      ))}
    </View>
  )
}

function TabButton(props: { icon: LucideIcon; label: string; selected: boolean; badge: number; onPress: () => void }) {
  useColorScheme()
  const [pressed, setPressed] = useState(false)
  const Icon = props.icon
  const tint = props.selected ? colors.textPrimary : colors.textMuted
  return (
    <Pressable
      style={styles.tab}
      accessibilityRole="tab"
      accessibilityLabel={props.badge > 0 ? `${props.label}, ${props.badge}` : props.label}
      accessibilityState={{ selected: props.selected }}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={props.onPress}
    >
      <Animated.View
        style={[
          styles.icon,
          {
            transform: [{ scale: pressed ? 0.88 : 1 }],
            transitionProperty: 'transform',
            transitionDuration: pressed ? 90 : 160,
            transitionTimingFunction: 'ease-out'
          }
        ]}
      >
        <Icon size={25} strokeWidth={props.selected ? 2.2 : 1.8} color={tint} />
        {props.badge > 0 ? <TabBadge count={props.badge} /> : null}
      </Animated.View>
      <Text style={[styles.label, { color: tint }]} numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  )
}

function TabBadge({ count }: { count: number }) {
  useColorScheme()
  const reducedMotion = useReducedMotionEnabled() === true
  const scale = useSharedValue(reducedMotion ? 1 : 0.6)
  const opacity = useSharedValue(reducedMotion ? 1 : 0)

  useEffect(() => {
    if (reducedMotion) return
    opacity.value = withTiming(1, { duration: 140, easing: EASE_OUT })
    scale.value = withSequence(
      withTiming(1.18, { duration: 140, easing: EASE_OUT }),
      withTiming(1, { duration: 160, easing: EASE_OUT })
    )
  }, [count, opacity, reducedMotion, scale])

  const style = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ scale: scale.value }] }), [opacity, scale])
  return (
    <Animated.View style={[styles.badge, style]} pointerEvents="none">
      <Text style={styles.badgeText}>{tabBadgeLabel(count)}</Text>
    </Animated.View>
  )
}

const styles = themedStyleSheet(() => ({
  bar: {
    flexDirection: 'row',
    paddingTop: 6,
    paddingHorizontal: spacing.xs,
    backgroundColor: colors.bgBase,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  tab: { flex: 1, minHeight: 44, alignItems: 'center', gap: 3, paddingTop: 2 },
  icon: { width: 30, height: 26, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 10.5, fontWeight: '500', letterSpacing: 0.1 },
  badge: {
    position: 'absolute',
    top: -4,
    left: 20,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.statusAmber,
    borderWidth: 1.5,
    borderColor: colors.bgBase
  },
  badgeText: { fontSize: 11, fontWeight: '700', color: fixedColors.black }
}))
