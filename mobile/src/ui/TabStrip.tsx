import { useRef, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Plus } from 'lucide-react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming
} from 'react-native-reanimated'
import { AgentGlyph } from './AgentGlyph'
import type { GlyphActivity } from './agentGlyph'
import { triggerMediumImpact, triggerSelection } from './haptics'
import { SHEET_CURVE } from './motion'
import { colors, feedback, radii, spacing, themedStyleSheet, useColorScheme } from './theme'
import { useDrawerReducedMotion } from './useReducedMotionEnabled'

const SWIPE_SETTLE_MS = 250
const SWIPE_ENTRY_SHARE = 0.4
const FLICK_VELOCITY = 600
const EDGE_RESISTANCE = 0.25
const DRAG_CLICK_WINDOW_MS = 400

type TabStripProps = {
  title: string
  glyph?: { activity: GlyphActivity; stopped?: string | null }
  mark?: ReactNode
  count: number
  othersNeedYou: boolean
  hasPrevious: boolean
  hasNext: boolean
  newDisabled?: boolean
  onStep: (direction: 'previous' | 'next') => void
  onOpenActions: () => void
  onOpenTabs: () => void
  onNew: () => void
}

export function TabStrip({
  title,
  glyph,
  mark,
  count,
  othersNeedYou,
  hasPrevious,
  hasNext,
  newDisabled = false,
  onStep,
  onOpenActions,
  onOpenTabs,
  onNew
}: TabStripProps) {
  useColorScheme()
  const reducedMotion = useDrawerReducedMotion()
  const offset = useSharedValue(0)
  const width = useSharedValue(0)
  const dragEndedAtRef = useRef(0)
  const settle = (to: number) =>
    withTiming(
      to,
      reducedMotion
        ? { duration: 0, reduceMotion: ReduceMotion.Never }
        : { duration: SWIPE_SETTLE_MS, easing: Easing.bezier(...SHEET_CURVE) }
    )
  const step = (direction: 1 | -1) => {
    const available = direction === 1 ? hasPrevious : hasNext
    if (!available) {
      offset.value = settle(0)
      return
    }
    triggerSelection()
    onStep(direction === 1 ? 'previous' : 'next')
    offset.value = withSequence(withTiming(-direction * width.value * SWIPE_ENTRY_SHARE, { duration: 0 }), settle(0))
  }
  const pan = Gesture.Pan()
    .runOnJS(true)
    .enabled(count > 1)
    .activeOffsetX([-12, 12])
    .failOffsetY([-10, 10])
    .onUpdate((event) => {
      const available = event.translationX > 0 ? hasPrevious : hasNext
      offset.value = available ? event.translationX : event.translationX * EDGE_RESISTANCE
    })
    .onEnd((event, success) => {
      dragEndedAtRef.current = Date.now()
      if (!success) {
        offset.value = settle(0)
        return
      }
      const direction = event.translationX > 0 ? 1 : -1
      const flicked = Math.abs(event.velocityX) > FLICK_VELOCITY && Math.sign(event.velocityX) === direction
      if (Math.abs(event.translationX) > width.value / 2 || flicked) {
        step(direction)
        return
      }
      offset.value = settle(0)
    })
  const contentStyle = useAnimatedStyle(
    () => ({
      transform: [{ translateX: offset.value }],
      opacity: 1 - Math.min(Math.abs(offset.value) / Math.max(width.value, 1), 1) * 0.6
    }),
    [offset, width]
  )

  const openActions = () => {
    if (Date.now() - dragEndedAtRef.current < DRAG_CLICK_WINDOW_MS) return
    onOpenActions()
  }
  const countLabel = count === 1 ? '1 tab' : `${count} tabs`

  return (
    <View style={styles.bar}>
      <GestureDetector gesture={pan} touchAction="pan-y">
        <View style={styles.tabCell} onLayout={(event) => (width.value = event.nativeEvent.layout.width)}>
          <Pressable
            style={({ pressed }) => [styles.tabPress, pressed && styles.cellPressed]}
            onPress={openActions}
            onLongPress={() => {
              triggerMediumImpact()
              openActions()
            }}
            delayLongPress={400}
            accessibilityRole="button"
            accessibilityLabel={title}
            accessibilityHint="Shows actions for this tab"
            accessibilityActions={[
              ...(hasNext ? [{ name: 'nextTab', label: 'Next tab' }] : []),
              ...(hasPrevious ? [{ name: 'previousTab', label: 'Previous tab' }] : [])
            ]}
            onAccessibilityAction={(event) => {
              const name = event.nativeEvent.actionName
              if (name === 'nextTab') step(-1)
              else if (name === 'previousTab') step(1)
            }}
          >
            <Animated.View style={[styles.tabContent, contentStyle]}>
              {glyph ? <AgentGlyph activity={glyph.activity} stopped={glyph.stopped} size="tab" decorative /> : null}
              {mark ? <View style={styles.mark}>{mark}</View> : null}
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
            </Animated.View>
          </Pressable>
        </View>
      </GestureDetector>
      <Pressable
        style={({ pressed }) => [styles.sideCell, pressed && styles.cellPressed]}
        onPress={onOpenTabs}
        accessibilityRole="button"
        accessibilityLabel={othersNeedYou ? `${countLabel}, another tab needs you` : countLabel}
        accessibilityHint="Shows all tabs"
      >
        <View style={styles.countBox}>
          <Text style={styles.countText}>{count}</Text>
          {othersNeedYou ? <View style={styles.alert} /> : null}
        </View>
      </Pressable>
      <Pressable
        style={({ pressed }) => [styles.sideCell, styles.lastCell, pressed && styles.cellPressed, newDisabled && styles.cellDisabled]}
        disabled={newDisabled}
        onPress={onNew}
        accessibilityRole="button"
        accessibilityLabel="New tab"
        accessibilityState={{ disabled: newDisabled }}
      >
        <Plus size={18} color={colors.textPrimary} strokeWidth={2.2} />
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  bar: { height: 44, flexDirection: 'row', alignItems: 'stretch', borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  tabCell: {
    flex: 1,
    minWidth: 0,
    backgroundColor: colors.bgRaised,
    borderBottomWidth: 2,
    borderBottomColor: colors.textSecondary,
    borderRightWidth: 1,
    borderRightColor: colors.borderSubtle,
    overflow: 'hidden'
  },
  tabPress: { flex: 1, justifyContent: 'center', paddingLeft: spacing.lg, paddingRight: spacing.sm },
  tabContent: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  mark: { flexShrink: 0 },
  title: { flexShrink: 1, minWidth: 0, fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  sideCell: {
    width: 46,
    flexDirection: 'row',
    gap: 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: colors.borderSubtle
  },
  lastCell: { borderRightWidth: 0 },
  cellPressed: { backgroundColor: colors.translucentFill },
  cellDisabled: { opacity: feedback.disabledOpacity },
  countBox: {
    minWidth: 19,
    height: 19,
    paddingHorizontal: 3,
    borderRadius: 6,
    borderWidth: 1.8,
    borderColor: colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center'
  },
  countText: { fontSize: 11, fontWeight: '700', color: colors.textPrimary, fontVariant: ['tabular-nums'] },
  alert: {
    position: 'absolute',
    top: -6,
    right: -7,
    width: 9,
    height: 9,
    borderRadius: radii.pill,
    backgroundColor: colors.statusRed,
    borderWidth: 2,
    borderColor: colors.bgPanel
  }
}))
