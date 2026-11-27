import { useEffect, useRef, useState } from 'react'
import { Animated, Easing, View } from 'react-native'
import { fixedColors, radii, themedStyleSheet } from '@/ui/theme'
import { useReducedMotionEnabled } from '@/ui/useReducedMotionEnabled'

const MAX_SIDE = 360
const FRACTION = 0.62
const SQUEEZE = 0.94
const SQUEEZE_MS = 140

export function ScanReticle({ decoded }: { decoded: boolean }) {
  const [side, setSide] = useState(0)
  const scale = useRef(new Animated.Value(1)).current
  const reducedMotion = useReducedMotionEnabled()

  useEffect(() => {
    if (reducedMotion) {
      scale.setValue(1)
      return
    }
    Animated.timing(scale, {
      toValue: decoded ? SQUEEZE : 1,
      duration: SQUEEZE_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true
    }).start()
  }, [decoded, reducedMotion, scale])

  return (
    <View
      style={styles.fill}
      pointerEvents="none"
      onLayout={({ nativeEvent: { layout } }) => setSide(Math.min(Math.min(layout.width, layout.height) * FRACTION, MAX_SIDE))}
    >
      {side > 0 ? (
        <Animated.View
          style={[{ width: side, height: side, opacity: reducedMotion && decoded ? 0.4 : 1 }, { transform: [{ scale }] }]}
        >
          <View style={[styles.corner, styles.topLeft]} />
          <View style={[styles.corner, styles.topRight]} />
          <View style={[styles.corner, styles.bottomLeft]} />
          <View style={[styles.corner, styles.bottomRight]} />
        </Animated.View>
      ) : null}
    </View>
  )
}

const EDGE = { borderColor: fixedColors.white, opacity: 0.7 }

const styles = themedStyleSheet(() => ({
  fill: { ...({ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const), alignItems: 'center', justifyContent: 'center' },
  corner: { position: 'absolute', width: 28, height: 28, borderRadius: radii.mark, ...EDGE },
  topLeft: { top: 0, left: 0, borderTopWidth: 2.5, borderLeftWidth: 2.5 },
  topRight: { top: 0, right: 0, borderTopWidth: 2.5, borderRightWidth: 2.5 },
  bottomLeft: { bottom: 0, left: 0, borderBottomWidth: 2.5, borderLeftWidth: 2.5 },
  bottomRight: { bottom: 0, right: 0, borderBottomWidth: 2.5, borderRightWidth: 2.5 }
}))
