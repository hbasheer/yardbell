import { useRef, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated'
import { SHEET_CURVE, SHEET_HEIGHT_DURATION_MS } from './motion'
import { useReducedMotionEnabled } from './useReducedMotionEnabled'

const HEIGHT_TIMING = { duration: SHEET_HEIGHT_DURATION_MS, easing: Easing.bezier(...SHEET_CURVE) }

export function AutoHeight({ children, maxHeight }: { children: ReactNode; maxHeight?: number }) {
  const reducedMotion = useReducedMotionEnabled()
  const [measured, setMeasured] = useState(false)
  const height = useSharedValue(0)
  const contentHeight = useRef(0)
  const frameStyle = useAnimatedStyle(() => (measured ? { height: height.value } : {}), [height, measured])

  return (
    <Animated.View style={[styles.frame, frameStyle]}>
      <View
        style={[measured ? styles.contentMeasured : null, maxHeight === undefined ? null : { maxHeight }]}
        onLayout={(event) => {
          const next = event.nativeEvent.layout.height
          contentHeight.current = next
          if (!measured) {
            height.value = next
            setMeasured(true)
            return
          }
          easeHeight(height, next, reducedMotion)
        }}
      >
        {children}
      </View>
    </Animated.View>
  )
}

function easeHeight(height: SharedValue<number>, next: number, reducedMotion: boolean | null): void {
  if (reducedMotion === true) {
    height.value = next
    return
  }
  height.value = withTiming(next, HEIGHT_TIMING)
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden' },
  contentMeasured: { position: 'absolute', top: 0, left: 0, right: 0 }
})
