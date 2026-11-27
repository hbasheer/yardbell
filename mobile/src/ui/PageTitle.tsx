import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Animated,
  Platform,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from 'react-native'
import { colors, spacing, themedStyleSheet, useColorScheme } from './theme'

const FALLBACK_TITLE_HEIGHT = 62
const WEB_SETTLE_DELAY_MS = 80
const NATIVE_SNAP = Platform.OS !== 'web'

type PageTitleProps = {
  title: string
  subtitle?: ReactNode
  onLayout?: (event: LayoutChangeEvent) => void
}

export function PageTitle({ title, subtitle, onLayout }: PageTitleProps) {
  useColorScheme()
  return (
    <View style={styles.block} onLayout={onLayout}>
      <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
        {title}
      </Text>
      {subtitle !== undefined ? <View style={styles.subtitleRow}>{subtitle}</View> : null}
    </View>
  )
}

export type CollapsingTitle = ReturnType<typeof useCollapsingTitle>

export function useCollapsingTitle(scrollTo: (offset: number) => void) {
  const scrollY = useRef(new Animated.Value(0)).current
  const offsetRef = useRef(0)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touching = useRef(false)
  const [titleHeight, setTitleHeight] = useState(FALLBACK_TITLE_HEIGHT)

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current)
    },
    []
  )

  const scheduleSettle = useCallback(() => {
    if (NATIVE_SNAP) return
    if (settleTimer.current) clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(() => {
      const offset = offsetRef.current
      if (!touching.current && offset > 0 && offset < titleHeight) {
        scrollTo(offset < titleHeight / 2 ? 0 : titleHeight)
      }
    }, WEB_SETTLE_DELAY_MS)
  }, [scrollTo, titleHeight])

  const onScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
        useNativeDriver: Platform.OS !== 'web',
        listener: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
          offsetRef.current = event.nativeEvent.contentOffset.y
          scheduleSettle()
        }
      }),
    [scheduleSettle, scrollY]
  )

  const touchHandlers = useMemo(
    () => ({
      ...(NATIVE_SNAP ? { snapToOffsets: [0, titleHeight], snapToEnd: false } : null),
      onTouchStart: () => {
        touching.current = true
      },
      onTouchEnd: () => {
        touching.current = false
        scheduleSettle()
      },
      onTouchCancel: () => {
        touching.current = false
        scheduleSettle()
      }
    }),
    [scheduleSettle, titleHeight]
  )

  const onTitleLayout = useCallback((event: LayoutChangeEvent) => {
    const height = Math.round(event.nativeEvent.layout.height)
    if (height > 0) setTitleHeight(height)
  }, [])

  const reset = useCallback(() => {
    offsetRef.current = 0
    scrollY.setValue(0)
  }, [scrollY])

  const barTitleOpacity = useMemo(
    () =>
      scrollY.interpolate({
        inputRange: [titleHeight * 0.35, titleHeight * 0.7],
        outputRange: [0, 1],
        extrapolate: 'clamp'
      }),
    [scrollY, titleHeight]
  )
  const barDividerOpacity = useMemo(
    () =>
      scrollY.interpolate({
        inputRange: [titleHeight * 0.7, titleHeight],
        outputRange: [0, 1],
        extrapolate: 'clamp'
      }),
    [scrollY, titleHeight]
  )

  return { onScroll, touchHandlers, onTitleLayout, reset, barTitleOpacity, barDividerOpacity }
}

const styles = themedStyleSheet(() => ({
  block: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, paddingBottom: spacing.md, gap: 3 },
  title: { color: colors.textPrimary, fontSize: 24, lineHeight: 30, fontWeight: '700', letterSpacing: -0.3 },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5, minWidth: 0 }
}))
