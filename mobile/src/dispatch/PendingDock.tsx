import { Check, X } from 'lucide-react-native'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { StepCard } from '../steps/StepCard'
import type { AgentChoice } from '../steps/StepEditor'
import { colors, feedback, radii, spacing, themedStyleSheet, useColorScheme } from '../ui/theme'
import { REDUCED_MOTION_FADE_MS, SHEET_CURVE, SHEET_HEIGHT_DURATION_MS } from '../ui/motion'
import { useReducedMotionEnabled } from '../ui/useReducedMotionEnabled'
import { waitingText } from './chatModel'
import type { ActionEvent, Decision } from './types'

const CURVE = Easing.bezier(...SHEET_CURVE)

type Props = {
  pending: ActionEvent[]
  all: boolean
  shown: ActionEvent
  bodyMaxHeight: number
  onDecide: (step: ActionEvent, decision: Decision, input?: Record<string, unknown>, again?: boolean) => Promise<void>
  onDecideAll: (decision: Decision) => Promise<void>
  onOpenSession: (machine: string, name: string) => void
  machines?: string[]
  agents?: AgentChoice[]
}

export function PendingDock({ pending, all: offerAll, shown, bodyMaxHeight, onDecide, onDecideAll, onOpenSession, machines, agents }: Props) {
  useColorScheme()
  const reducedMotion = useReducedMotionEnabled() === true
  const [height, setHeight] = useState(0)
  const [all, setAll] = useState<Decision | null>(null)
  const rise = useSharedValue(0)
  const risen = useRef(false)

  useEffect(() => {
    if (risen.current || height === 0) return
    risen.current = true
    rise.value = withTiming(1, { duration: reducedMotion ? REDUCED_MOTION_FADE_MS : SHEET_HEIGHT_DURATION_MS, easing: CURVE })
  }, [height, reducedMotion, rise])

  const style = useAnimatedStyle(
    () =>
      reducedMotion
        ? { opacity: rise.value }
        : { opacity: height === 0 ? 0 : 1, transform: [{ translateY: (1 - rise.value) * height }] },
    [reducedMotion, height]
  )

  const position = pending.findIndex((step) => step.id === shown.id) + 1

  const decideAll = async (decision: Decision) => {
    setAll(decision)
    try {
      await onDecideAll(decision)
    } finally {
      setAll(null)
    }
  }

  return (
    <Animated.View style={[styles.dock, style]} onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
      <View style={styles.head}>
        <Text style={styles.count} accessibilityRole="header">{`${position} of ${pending.length}`}</Text>
        {offerAll ? (
          <View style={styles.allButtons}>
            <Pressable
              onPress={() => void decideAll('reject')}
              disabled={all !== null}
              accessibilityRole="button"
              accessibilityLabel="Reject all"
              style={({ pressed }) => [styles.allButton, styles.outline, (pressed || all === 'reject') && styles.pressed]}
            >
              {all === 'reject' ? <ActivityIndicator size="small" color={colors.textPrimary} /> : <X size={14} color={colors.textPrimary} strokeWidth={2.4} />}
              <Text style={styles.allText} numberOfLines={1}>
                Reject all
              </Text>
            </Pressable>
            <Pressable
              onPress={() => void decideAll('approve')}
              disabled={all !== null}
              accessibilityRole="button"
              accessibilityLabel="Approve all"
              style={({ pressed }) => [styles.allButton, styles.solid, (pressed || all === 'approve') && styles.pressed]}
            >
              {all === 'approve' ? <ActivityIndicator size="small" color={colors.bgBase} /> : <Check size={14} color={colors.bgBase} strokeWidth={2.4} />}
              <Text style={[styles.allText, styles.solidText]} numberOfLines={1}>
                Approve all
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>
      <Text style={styles.waiting} numberOfLines={2}>
        {waitingText(pending.length)}
      </Text>
      <StepCard
        key={shown.id}
        step={shown}
        onDecide={(decision, input, again) => onDecide(shown, decision, input, again)}
        onOpenSession={onOpenSession}
        machines={machines}
        agents={agents}
        bodyMaxHeight={bodyMaxHeight}
      />
    </Animated.View>
  )
}

const styles = themedStyleSheet(() => ({
  dock: { marginHorizontal: spacing.sm, marginBottom: 6, gap: 6 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, paddingHorizontal: spacing.xs },
  count: { flexShrink: 0, fontSize: 13, fontWeight: '700', color: colors.textPrimary, fontVariant: ['tabular-nums'] },
  allButtons: { flexDirection: 'row', gap: spacing.sm, flexShrink: 1 },
  allButton: {
    minHeight: 34,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexShrink: 1
  },
  outline: { borderWidth: 1, borderColor: colors.choiceBorder },
  solid: { backgroundColor: colors.textPrimary },
  allText: { fontSize: 13.5, fontWeight: '700', color: colors.textPrimary, flexShrink: 1 },
  solidText: { color: colors.bgBase },
  pressed: { opacity: feedback.pressedOpacity },
  waiting: { fontSize: 12, lineHeight: 16, color: colors.textMuted, paddingHorizontal: spacing.xs }
}))
