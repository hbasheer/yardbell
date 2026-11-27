import { MessageCircleQuestion } from 'lucide-react-native'
import { Animated, View, type ViewStyle } from 'react-native'
import { agentGlyphKind, agentGlyphLabel, type AgentGlyphKind, type GlyphActivity } from './agentGlyph'
import { agentColors, colors, radii, themedStyleSheet, useColorScheme } from './theme'
import { useReducedMotionEnabled } from './useReducedMotionEnabled'
import { useWorkingRingRotation } from './useWorkingMotion'

const LIST_SLOT = 12
const TAB_SLOT = 10

function WorkingRing({ color, style }: { color: string; style: ViewStyle }) {
  const still = useReducedMotionEnabled() !== false
  const ring = useWorkingRingRotation(!still)
  return (
    <Animated.View
      style={[style, { borderColor: color, borderTopColor: still ? color : 'transparent' }, still ? undefined : ring.style]}
    />
  )
}

type Props = {
  activity: GlyphActivity
  stopped?: string | null
  size?: 'list' | 'tab'
  decorative?: boolean
}

export function AgentGlyph({ activity, stopped, size = 'list', decorative = false }: Props) {
  useColorScheme()
  const kind: AgentGlyphKind = agentGlyphKind({ activity, stopped })
  const small = size === 'tab'
  const slot = small ? styles.slotTab : styles.slotList
  const hidden = decorative
    ? {
        'aria-hidden': true,
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no-hide-descendants' as const
      }
    : { accessible: true, accessibilityLabel: agentGlyphLabel(kind) }

  return (
    <View {...hidden} style={slot}>
      {kind === 'working' ? (
        <WorkingRing color={agentColors.working} style={small ? styles.ringTab : styles.ringList} />
      ) : kind === 'question' ? (
        <MessageCircleQuestion size={small ? TAB_SLOT : LIST_SLOT} color={colors.agentQuestion} />
      ) : (
        <View
          style={[
            small ? styles.dotTab : styles.dotList,
            { backgroundColor: kind === 'stopped' ? agentColors.failed : agentColors.idle }
          ]}
        />
      )}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  slotList: { width: LIST_SLOT, height: LIST_SLOT, alignItems: 'center', justifyContent: 'center' },
  slotTab: { width: TAB_SLOT, height: TAB_SLOT, alignItems: 'center', justifyContent: 'center' },
  dotList: { width: 8, height: 8, borderRadius: radii.pill },
  dotTab: { width: 6, height: 6, borderRadius: radii.pill },
  ringList: { width: 8, height: 8, borderRadius: radii.pill, borderWidth: 2 },
  ringTab: { width: 6, height: 6, borderRadius: radii.pill, borderWidth: 1.5 }
}))
