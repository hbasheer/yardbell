import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type HostInstance
} from 'react-native'
import { Check } from 'lucide-react-native'
import type { ActionSheetAction } from './ActionSheet'
import { MENU_WIDTH, pullDownAnchor, pullDownMaxHeight, type PullDownAnchor } from './pullDownPlacement'
import { colors, fixedColors, radii, spacing, themedStyleSheet, typography, useColorScheme } from './theme'
import { useReducedMotionEnabled } from './useReducedMotionEnabled'

const OPEN_SPRING = { stiffness: 420, damping: 32, mass: 1 }
const CLOSE_FADE_MS = 150

type PullDownMenuProps = {
  visible: boolean
  anchorRef: RefObject<HostInstance | null>
  groups: readonly (readonly ActionSheetAction[])[]
  onClose: () => void
}

export function PullDownMenu({ visible, anchorRef, groups, onClose }: PullDownMenuProps) {
  useColorScheme()
  const window = useWindowDimensions()
  const reducedMotion = useReducedMotionEnabled()
  const [anchor, setAnchor] = useState<PullDownAnchor | null>(null)
  const [presented, setPresented] = useState(visible)
  if (visible && !presented) setPresented(true)
  const pendingRef = useRef<(() => void) | null>(null)
  const appear = useRef(new Animated.Value(0)).current
  const nativeDriver = Platform.OS !== 'web'

  useLayoutEffect(() => {
    if (!visible) return
    anchorRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor(pullDownAnchor({ x, y, width, height }, window))
    })
  }, [anchorRef, visible, window.width, window.height])

  useEffect(() => {
    if (!visible || anchor === null) return
    appear.setValue(0)
    const open =
      reducedMotion === true
        ? Animated.timing(appear, { toValue: 1, duration: CLOSE_FADE_MS, useNativeDriver: nativeDriver })
        : Animated.spring(appear, { toValue: 1, ...OPEN_SPRING, useNativeDriver: nativeDriver })
    open.start()
    return () => open.stop()
  }, [anchor, appear, reducedMotion, visible, nativeDriver])

  useEffect(() => {
    if (visible || !presented) return
    const close = Animated.timing(appear, {
      toValue: 0,
      duration: CLOSE_FADE_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: nativeDriver
    })
    close.start(({ finished }) => {
      if (finished) {
        setPresented(false)
        setAnchor(null)
      }
    })
    return () => close.stop()
  }, [appear, presented, visible, nativeDriver])

  useEffect(() => {
    if (presented || !pendingRef.current) return
    const run = pendingRef.current
    pendingRef.current = null
    const frame = requestAnimationFrame(run)
    return () => cancelAnimationFrame(frame)
  }, [presented])

  const press = (action: ActionSheetAction) => {
    if (action.closeBeforePress) {
      pendingRef.current = action.onPress
      onClose()
      return
    }
    action.onPress()
    if (!action.skipAutoClose) onClose()
  }

  const shown = groups.map((group) => group.filter(Boolean)).filter((group) => group.length > 0)
  return (
    <Modal visible={presented} transparent animationType="none" onRequestClose={onClose}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} disabled={!visible} accessibilityLabel="Close menu" />
      {anchor ? (
        <Animated.View
          style={[
            styles.menu,
            anchor,
            { maxHeight: pullDownMaxHeight(anchor, window.height) },
            {
              opacity: appear.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }),
              transformOrigin: 'top' in anchor ? 'top right' : 'bottom right',
              transform: [
                { scale: appear.interpolate({ inputRange: [0, 1], outputRange: [reducedMotion === true ? 1 : 0.9, 1] }) }
              ]
            }
          ]}
          accessibilityRole="menu"
        >
          <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
            {shown.map((group, groupIndex) => (
              <View key={groupIndex} style={groupIndex > 0 && styles.groupGap}>
                {group.map((action, index) => {
                  const Icon = action.icon
                  const tint = action.destructive ? colors.statusRed : colors.textPrimary
                  return (
                    <Pressable
                      key={action.id ?? action.label}
                      style={({ pressed }) => [
                        styles.item,
                        index > 0 && styles.itemDivider,
                        pressed && styles.itemPressed,
                        action.disabled && styles.itemDisabled
                      ]}
                      disabled={action.disabled || action.loading}
                      onPress={() => press(action)}
                      accessibilityRole="menuitem"
                      accessibilityLabel={action.status ? `${action.label}, ${action.status}` : action.label}
                      accessibilityHint={action.hint}
                      accessibilityState={action.checked === undefined ? undefined : { checked: action.checked }}
                    >
                      <View style={styles.labelBlock}>
                        <Text style={[styles.label, { color: tint }]} numberOfLines={1}>
                          {action.label}
                        </Text>
                        {(action.disabled || action.destructive) && action.hint ? (
                          <Text style={styles.hint} numberOfLines={2}>
                            {action.hint}
                          </Text>
                        ) : null}
                      </View>
                      {action.status ? (
                        <Text style={styles.status} numberOfLines={1}>
                          {action.status}
                        </Text>
                      ) : null}
                      {action.checked ? (
                        <Check size={17} color={tint} strokeWidth={2.2} />
                      ) : action.renderIcon ? (
                        action.renderIcon()
                      ) : (
                        Icon && <Icon size={17} color={tint} strokeWidth={2} />
                      )}
                    </Pressable>
                  )
                })}
              </View>
            ))}
          </ScrollView>
        </Animated.View>
      ) : null}
    </Modal>
  )
}

const styles = themedStyleSheet(() => ({
  menu: {
    position: 'absolute',
    width: MENU_WIDTH,
    borderRadius: radii.surface,
    overflow: 'hidden',
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    shadowColor: fixedColors.black,
    shadowOpacity: 0.45,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12
  },
  groupGap: { borderTopWidth: 6, borderTopColor: colors.bgBase },
  item: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.lg
  },
  itemDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
  itemPressed: { backgroundColor: colors.translucentFill },
  itemDisabled: { opacity: 0.4 },
  labelBlock: { flexShrink: 1, gap: 2 },
  label: { flexShrink: 1, fontSize: 15.5 },
  hint: { color: colors.textSecondary, fontSize: typography.metaSize },
  status: {
    marginLeft: 'auto',
    flexShrink: 0,
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontVariant: ['tabular-nums']
  }
}))
