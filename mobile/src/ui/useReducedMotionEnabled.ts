import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'
import { useReducedMotion } from 'react-native-reanimated'

export function useReducedMotionEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let mounted = true
    AccessibilityInfo.isReduceMotionEnabled()
      .then((next) => {
        if (mounted) setEnabled(next)
      })
      .catch(() => undefined)
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setEnabled)
    return () => {
      mounted = false
      subscription.remove()
    }
  }, [])

  return enabled
}

export function useDrawerReducedMotion(): boolean {
  const launchValue = useReducedMotion()
  return useReducedMotionEnabled() ?? launchValue
}
