import { useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Easing, Platform, type LayoutChangeEvent } from 'react-native'

const nativeDriver = Platform.OS !== 'web'

export function useWorkingRingRotation(active: boolean) {
  const spin = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (!active) {
      spin.setValue(0)
      return undefined
    }
    const animation = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1000,
        easing: Easing.linear,
        isInteraction: false,
        useNativeDriver: nativeDriver
      })
    )
    animation.start()
    return () => animation.stop()
  }, [active, spin])
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
  return { style: { transform: [{ rotate }] } }
}

const SWEEP_END = 3.6

export function useWorkingSweep(active: boolean) {
  const progress = useRef(new Animated.Value(0)).current
  const [segmentWidth, setSegmentWidth] = useState(0)
  useEffect(() => {
    if (!active) {
      progress.setValue(0)
      return undefined
    }
    const animation = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 1400,
        easing: Easing.bezier(0.45, 0, 0.55, 1),
        isInteraction: false,
        useNativeDriver: nativeDriver
      })
    )
    animation.start()
    return () => animation.stop()
  }, [active, progress])
  const translateX = useMemo(
    () =>
      progress.interpolate({
        inputRange: [0, 1],
        outputRange: [-segmentWidth, segmentWidth * SWEEP_END]
      }),
    [progress, segmentWidth]
  )
  return {
    style: { opacity: segmentWidth === 0 ? 0 : 1, transform: [{ translateX }] },
    onLayout: (event: LayoutChangeEvent) => setSegmentWidth(event.nativeEvent.layout.width)
  }
}
