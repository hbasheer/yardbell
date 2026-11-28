import { X } from 'lucide-react-native'
import { useState } from 'react'
import { Image, Modal, Pressable, Text, View, useWindowDimensions } from 'react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { feedback, fixedColors, radii, spacing, themedStyleSheet, useColorScheme } from '../../ui/theme'
import { clampOffset, clampScale, doubleTapTarget, fitScale, MAX_ZOOM, pinchOffset } from './zoom'

export type EvidenceImage = { name: string; size: string; width: number; height: number; source: { uri: string; headers: { Authorization: string } } }

const SETTLE = { duration: 180 }

export function EvidenceViewer({ image, onClose }: { image: EvidenceImage | null; onClose: () => void }) {
  return (
    <Modal visible={image !== null} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {image ? (
        <GestureHandlerRootView style={styles.fill}>
          <Stage image={image} onClose={onClose} />
        </GestureHandlerRootView>
      ) : null}
    </Modal>
  )
}

function Stage({ image, onClose }: { image: EvidenceImage; onClose: () => void }) {
  useColorScheme()
  const insets = useSafeAreaInsets()
  const window = useWindowDimensions()
  const [failed, setFailed] = useState(false)
  const view = { width: window.width, height: window.height - insets.top - insets.bottom - HEADER }
  const fit = fitScale(image.width, image.height, view.width, view.height)
  const baseWidth = image.width * fit
  const baseHeight = image.height * fit

  const scale = useSharedValue(1)
  const x = useSharedValue(0)
  const y = useSharedValue(0)
  const savedScale = useSharedValue(1)
  const savedX = useSharedValue(0)
  const savedY = useSharedValue(0)
  const startFocalX = useSharedValue(0)
  const startFocalY = useSharedValue(0)

  const settle = () => {
    'worklet'
    const nx = clampOffset(x.value, baseWidth * scale.value, view.width)
    const ny = clampOffset(y.value, baseHeight * scale.value, view.height)
    x.value = withTiming(nx, SETTLE)
    y.value = withTiming(ny, SETTLE)
  }

  const pinch = Gesture.Pinch()
    .onStart((e) => {
      savedScale.value = scale.value
      savedX.value = x.value
      savedY.value = y.value
      startFocalX.value = e.focalX - view.width / 2
      startFocalY.value = e.focalY - view.height / 2
    })
    .onUpdate((e) => {
      const next = clampScale(savedScale.value * e.scale, 1, MAX_ZOOM)
      x.value = pinchOffset(e.focalX - view.width / 2, startFocalX.value, savedX.value, savedScale.value, next)
      y.value = pinchOffset(e.focalY - view.height / 2, startFocalY.value, savedY.value, savedScale.value, next)
      scale.value = next
    })
    .onEnd(() => {
      if (scale.value <= 1.001) {
        x.value = withTiming(0, SETTLE)
        y.value = withTiming(0, SETTLE)
      } else settle()
    })

  const pan = Gesture.Pan()
    .minDistance(4)
    .onStart(() => {
      savedX.value = x.value
      savedY.value = y.value
    })
    .onUpdate((e) => {
      x.value = savedX.value + e.translationX
      y.value = savedY.value + e.translationY
    })
    .onEnd(() => settle())

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const target = doubleTapTarget(scale.value, fit)
      scale.value = withTiming(target, SETTLE)
      x.value = withTiming(0, SETTLE)
      y.value = withTiming(0, SETTLE)
    })

  const gesture = Gesture.Race(doubleTap, Gesture.Simultaneous(pinch, pan))

  const moved = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }]
  }))

  return (
    <View style={[styles.backdrop, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <View style={styles.titles}>
          <Text style={styles.title} numberOfLines={1}>
            {image.name}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {[image.size, 'Double tap to switch between fit and actual size'].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close the screenshot" style={({ pressed }) => [styles.close, pressed && { opacity: feedback.pressedOpacity }]}>
          <X size={22} color={fixedColors.white} strokeWidth={2} />
        </Pressable>
      </View>
      <GestureDetector gesture={gesture}>
        <View style={styles.stage}>
          {failed ? (
            <Text style={styles.failed}>The screenshot could not be loaded.</Text>
          ) : (
            <Animated.View style={[{ width: baseWidth, height: baseHeight }, moved]}>
              <Image
                source={image.source}
                accessibilityLabel={`Screenshot ${image.name}`}
                style={{ width: baseWidth, height: baseHeight }}
                resizeMode="contain"
                onError={() => setFailed(true)}
              />
            </Animated.View>
          )}
        </View>
      </GestureDetector>
    </View>
  )
}

const HEADER = 56

const styles = themedStyleSheet(() => ({
  fill: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: fixedColors.black },
  header: { height: HEADER, flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.lg, paddingRight: spacing.sm, gap: spacing.md },
  titles: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: '600', color: fixedColors.white },
  meta: { fontSize: 12, color: 'rgba(255, 255, 255, 0.65)' },
  close: { width: 44, height: 44, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255, 255, 255, 0.14)' },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  failed: { fontSize: 14, color: 'rgba(255, 255, 255, 0.7)' }
}))
