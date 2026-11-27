import type { LucideIcon } from 'lucide-react-native'
import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { SHEET_CURVE } from './motion'
import { feedback, themedStyleSheet, typography, useColorScheme } from './theme'
import { useDrawerReducedMotion } from './useReducedMotionEnabled'

const ACTION_WIDTH = 84
const SWIPE_SETTLE_MS = 250
const DRAG_CLICK_WINDOW_MS = 400

export type SwipeCellAction = {
  label: string
  accessibilityLabel: string
  icon: LucideIcon
  background: string
  foreground: string
  onPress: () => void
}

export function SwipeCell({
  leading,
  trailing,
  enabled = true,
  children
}: {
  leading?: SwipeCellAction
  trailing?: SwipeCellAction | readonly SwipeCellAction[]
  enabled?: boolean
  children: (guardPress: (onPress: () => void) => () => void) => ReactNode
}) {
  useColorScheme()
  const reducedMotion = useDrawerReducedMotion()
  const offset = useSharedValue(0)
  const start = useSharedValue(0)
  const dragEndedAt = useSharedValue(0)
  const trailingActions = trailing === undefined ? [] : [trailing].flat()
  const maxRight = leading ? ACTION_WIDTH : 0
  const maxLeft = -ACTION_WIDTH * trailingActions.length
  const settle = (to: number) => {
    'worklet'
    return withTiming(
      to,
      reducedMotion
        ? { duration: 0, reduceMotion: ReduceMotion.Never }
        : { duration: SWIPE_SETTLE_MS, easing: Easing.bezier(...SHEET_CURVE) }
    )
  }
  const pan = Gesture.Pan()
    .enabled(enabled)
    .activeOffsetX([-12, 12])
    .failOffsetY([-10, 10])
    .onBegin(() => {
      start.value = offset.value
    })
    .onUpdate((event) => {
      offset.value = Math.min(maxRight, Math.max(maxLeft, start.value + event.translationX))
    })
    .onEnd(() => {
      dragEndedAt.value = Date.now()
      offset.value = settle(offset.value > ACTION_WIDTH / 2 ? maxRight : offset.value < -ACTION_WIDTH / 2 ? maxLeft : 0)
    })
  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }), [offset])
  const actionsStyle = useAnimatedStyle(() => ({ opacity: offset.value === 0 ? 0 : 1 }), [offset])
  const guardPress = (onPress: () => void) => () => {
    if (Date.now() - dragEndedAt.value < DRAG_CLICK_WINDOW_MS) return
    if (offset.value !== 0) {
      offset.value = settle(0)
      return
    }
    onPress()
  }
  if (!leading && trailingActions.length === 0) return children((onPress) => onPress)

  const renderAction = (action: SwipeCellAction, fromRight: number | null) => {
    const Icon = action.icon
    return (
      <Pressable
        key={action.label}
        style={({ pressed }) => [
          styles.action,
          fromRight === null ? styles.leading : { right: fromRight * ACTION_WIDTH },
          { backgroundColor: action.background },
          pressed && styles.actionPressed
        ]}
        disabled={!enabled}
        onPress={() => {
          offset.value = settle(0)
          action.onPress()
        }}
        accessibilityRole="button"
        accessibilityLabel={action.accessibilityLabel}
      >
        <Icon size={17} color={action.foreground} strokeWidth={2.2} />
        <Text style={[styles.actionText, { color: action.foreground }]}>{action.label}</Text>
      </Pressable>
    )
  }
  return (
    <View>
      <Animated.View pointerEvents="box-none" style={[styles.actions, actionsStyle]}>
        {leading ? renderAction(leading, null) : null}
        {trailingActions.map((action, index) => renderAction(action, trailingActions.length - 1 - index))}
      </Animated.View>
      <GestureDetector gesture={pan} touchAction="pan-y">
        <Animated.View style={rowStyle}>{children(guardPress)}</Animated.View>
      </GestureDetector>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  action: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: ACTION_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2
  },
  actions: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  leading: { left: 0 },
  actionPressed: { opacity: feedback.pressedOpacity },
  actionText: { fontSize: typography.metaSize, fontWeight: '600' }
}))
