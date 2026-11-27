import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Keyboard, Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type ScrollViewInstance } from 'react-native'
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AutoHeight } from './AutoHeight'
import { bottomDrawerOffset, bottomDrawerScrim, bottomDrawerTravel } from './motion'
import { colors, fixedColors, radii, spacing, themedStyleSheet, useColorScheme } from './theme'
import { hideDrawer, showDrawer, useBottomDrawerDrag } from './useBottomDrawerDrag'
import { useDrawerReducedMotion } from './useReducedMotionEnabled'
import { useKeyboardHeight } from './useKeyboardHeight'

const HANDLE_AREA_HEIGHT = spacing.sm + 5 + spacing.md

type DrawerProps = {
  visible: boolean
  onClose: () => void
  onAfterClose?: () => void
  children: ReactNode
  dismissible?: boolean
  dragContentToDismiss?: boolean
  contentScrollable?: boolean
  fillAvailable?: boolean
}

export function BottomDrawer({ visible, onClose, onAfterClose, children, ...rest }: DrawerProps) {
  const [mounted, setMounted] = useState(visible)
  if (visible && !mounted) setMounted(true)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const afterCloseRef = useRef(onAfterClose)
  afterCloseRef.current = onAfterClose

  const handleHidden = useCallback(() => {
    if (visibleRef.current) return
    setMounted(false)
    afterCloseRef.current?.()
  }, [])

  if (!mounted) return null
  return (
    <MountedBottomDrawer {...rest} visible={visible} onClose={onClose} onHidden={handleHidden}>
      {children}
    </MountedBottomDrawer>
  )
}

function MountedBottomDrawer({
  visible,
  onClose,
  onHidden,
  children,
  dragContentToDismiss = true,
  contentScrollable = true,
  fillAvailable = false,
  dismissible = true
}: Omit<DrawerProps, 'onAfterClose'> & { onHidden: () => void }) {
  useColorScheme()
  const progress = useSharedValue(0)
  const fade = useSharedValue(0)
  const reducedMotion = useDrawerReducedMotion()
  const motion = useMemo(() => ({ progress, fade, reducedMotion }), [progress, fade, reducedMotion])
  const keyboardOffset = useSharedValue(0)
  const scrollOffsetY = useSharedValue(0)
  const scrollRef = useRef<ScrollViewInstance>(null)
  const { height: screenHeight } = useWindowDimensions()
  const sheetHeight = useSharedValue(screenHeight)
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardHeight()
  const keyboardInset = visible ? keyboard.height : 0

  useEffect(() => {
    if (visible) {
      scrollOffsetY.value = 0
      showDrawer(motion)
    } else {
      Keyboard.dismiss()
      hideDrawer(motion, onHidden)
    }
  }, [onHidden, visible])

  useEffect(() => {
    keyboardOffset.value = withTiming(keyboardInset, { duration: keyboard.duration })
  }, [keyboardInset, keyboard.duration, keyboardOffset])

  const dismiss = useCallback(() => {
    if (!visible || !dismissible) return
    Keyboard.dismiss()
    hideDrawer(motion, onClose)
  }, [dismissible, onClose, motion, visible])

  const { scrollHandler, scrollGesture, handlePanGesture, contentPanGesture } = useBottomDrawerDrag({
    ...motion,
    sheetHeight,
    screenHeight,
    scrollOffsetY,
    onDismiss: onClose,
    dismissible
  })

  const drawerStyle = useAnimatedStyle(() => {
    const keyboardShift = fillAvailable ? 0 : keyboardOffset.value
    const travel = bottomDrawerTravel(sheetHeight.value, screenHeight)
    return {
      opacity: fade.value,
      transform: [{ translateY: bottomDrawerOffset(progress.value, travel) - keyboardShift }]
    }
  }, [progress, fade, keyboardOffset, screenHeight, fillAvailable, sheetHeight])

  const backdropStyle = useAnimatedStyle(() => {
    const travel = bottomDrawerTravel(sheetHeight.value, screenHeight)
    return { opacity: fade.value * bottomDrawerScrim(progress.value, travel, sheetHeight.value) }
  }, [progress, fade, sheetHeight, screenHeight])

  const sheetMaxHeight = Math.max(0, screenHeight - insets.top - spacing.lg - (fillAvailable ? 0 : keyboardInset))
  const fillHeight = fillAvailable ? Math.max(0, screenHeight - insets.top - spacing.lg - keyboardInset) : undefined
  const contentCap = Math.max(0, sheetMaxHeight - (insets.bottom + spacing.lg) - HANDLE_AREA_HEIGHT)

  const handle = (
    <GestureDetector gesture={handlePanGesture}>
      <Animated.View style={styles.handleHitArea} accessibilityRole="button" accessibilityLabel="Dismiss drawer">
        <View style={styles.handle} />
      </Animated.View>
    </GestureDetector>
  )

  const content = !contentScrollable ? (
    <View style={[styles.staticContent, fillAvailable && styles.staticContentFill]}>{children}</View>
  ) : dragContentToDismiss ? (
    <GestureDetector gesture={contentPanGesture}>
      <Animated.View collapsable={false} style={styles.scrollFrame}>
        <GestureDetector gesture={scrollGesture}>
          <Animated.ScrollView
            ref={scrollRef}
            bounces={false}
            keyboardShouldPersistTaps="handled"
            onScroll={scrollHandler}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
          >
            {children}
          </Animated.ScrollView>
        </GestureDetector>
      </Animated.View>
    </GestureDetector>
  ) : (
    <ScrollView ref={scrollRef} bounces={false} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      {children}
    </ScrollView>
  )

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={dismiss}>
      <Animated.View
        pointerEvents={visible ? 'auto' : 'none'}
        style={styles.overlay}
        accessibilityViewIsModal
        aria-modal
      >
        <GestureHandlerRootView style={styles.root}>
          <Animated.View style={[styles.backdrop, backdropStyle]}>
            <Pressable style={styles.backdropPressable} onPress={dismiss} />
          </Animated.View>
          <View style={styles.anchor} pointerEvents="box-none">
            <Animated.View
              testID="bottom-drawer-sheet"
              style={[
                styles.drawer,
                fillAvailable ? styles.drawerFill : null,
                {
                  width: '100%',
                  maxHeight: sheetMaxHeight,
                  height: fillHeight,
                  marginBottom: fillAvailable ? keyboardInset : 0,
                  paddingBottom: fillAvailable && keyboardInset > 0 ? spacing.sm : insets.bottom + spacing.lg
                },
                drawerStyle
              ]}
              onLayout={(event) => {
                sheetHeight.value = event.nativeEvent.layout.height
              }}
            >
              {handle}
              {fillAvailable ? content : <AutoHeight maxHeight={contentCap}>{content}</AutoHeight>}
              <View style={styles.bottomExtension} />
            </Animated.View>
          </View>
        </GestureHandlerRootView>
      </Animated.View>
    </Modal>
  )
}

const styles = themedStyleSheet(() => ({
  overlay: { ...StyleSheet.absoluteFill, zIndex: 1000 },
  root: { flex: 1 },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: fixedColors.scrim },
  backdropPressable: { ...StyleSheet.absoluteFill },
  anchor: { flex: 1, justifyContent: 'flex-end' },
  drawer: {
    backgroundColor: colors.sheetSurface,
    borderTopLeftRadius: radii.floating,
    borderTopRightRadius: radii.floating,
    paddingHorizontal: spacing.md,
    elevation: 8
  },
  drawerFill: { overflow: 'hidden', flexDirection: 'column' },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 5,
    borderRadius: radii.pill,
    backgroundColor: colors.textMuted,
    opacity: 0.5
  },
  handleHitArea: { alignItems: 'center', paddingTop: spacing.sm, paddingBottom: spacing.md },
  staticContent: { flexShrink: 1, minHeight: 0 },
  staticContentFill: { flex: 1 },
  scrollFrame: { flexShrink: 1, minHeight: 0 },
  bottomExtension: {
    position: 'absolute',
    bottom: -500,
    left: 0,
    right: 0,
    height: 500,
    backgroundColor: colors.sheetSurface
  }
}))
