import { Gesture } from 'react-native-gesture-handler'
import {
  Easing,
  ReduceMotion,
  cancelAnimation,
  runOnJS,
  useAnimatedScrollHandler,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue
} from 'react-native-reanimated'
import {
  BOTTOM_DRAWER_HIDE_DURATION_MS,
  BOTTOM_DRAWER_SHOW_DURATION_MS,
  REDUCED_MOTION_DISMISS_FADE_MS,
  REDUCED_MOTION_FADE_MS,
  SETTLE_SPRING,
  SHEET_CURVE,
  bottomDrawerDismissMotion,
  bottomDrawerDragProgress,
  bottomDrawerOffset,
  bottomDrawerTravel,
  shouldDismissBottomDrawer
} from './motion'

const TOP_SCROLL_EPSILON = 1

export type DrawerMotion = {
  progress: SharedValue<number>
  fade: SharedValue<number>
  reducedMotion: boolean
}

function fadeTo(fade: { value: number }, to: number, duration: number, onDone?: () => void) {
  'worklet'
  fade.value = withTiming(to, { duration, reduceMotion: ReduceMotion.Never }, (finished) => {
    if (finished && onDone) runOnJS(onDone)()
  })
}

export function showDrawer({ progress, fade, reducedMotion }: DrawerMotion): void {
  'worklet'
  if (reducedMotion) {
    progress.value = 1
    fadeTo(fade, 1, REDUCED_MOTION_FADE_MS)
    return
  }
  fade.value = 1
  progress.value = withTiming(1, {
    duration: BOTTOM_DRAWER_SHOW_DURATION_MS,
    easing: Easing.bezier(...SHEET_CURVE)
  })
}

export function hideDrawer({ progress, fade, reducedMotion }: DrawerMotion, onDone: () => void): void {
  'worklet'
  if (reducedMotion) {
    fadeTo(fade, 0, REDUCED_MOTION_FADE_MS, onDone)
    return
  }
  progress.value = withTiming(
    0,
    { duration: BOTTOM_DRAWER_HIDE_DURATION_MS, easing: Easing.bezier(...SHEET_CURVE) },
    (finished) => {
      if (finished) runOnJS(onDone)()
    }
  )
}

function useDrawerDrag(
  args: DrawerMotion & { extent: SharedValue<number>; screenExtent: number; onDismiss: () => void }
) {
  const { progress, extent, screenExtent, reducedMotion, onDismiss } = args
  const dragging = useSharedValue(false)
  const dragStartOffset = useSharedValue(0)

  const begin = () => {
    'worklet'
    dragging.value = false
  }

  const follow = (translation: number) => {
    'worklet'
    const travel = bottomDrawerTravel(extent.value, screenExtent)
    if (!dragging.value) {
      cancelAnimation(progress)
      dragStartOffset.value = bottomDrawerOffset(progress.value, travel) - translation
      dragging.value = true
    }
    progress.value = bottomDrawerDragProgress(dragStartOffset.value + translation, travel)
  }

  const settle = (velocity: number) => {
    'worklet'
    dragging.value = false
    if (reducedMotion) {
      progress.value = 1
      return
    }
    const travel = bottomDrawerTravel(extent.value, screenExtent)
    progress.value = withSpring(1, { ...SETTLE_SPRING, velocity: travel > 0 ? -velocity / travel : 0 })
  }

  const release = (velocity: number) => {
    'worklet'
    if (!dragging.value) return
    dragging.value = false
    const travel = bottomDrawerTravel(extent.value, screenExtent)
    const offset = bottomDrawerOffset(progress.value, travel)
    if (!shouldDismissBottomDrawer(offset, velocity, extent.value)) {
      settle(velocity)
      return
    }
    if (reducedMotion) {
      fadeTo(args.fade, 0, REDUCED_MOTION_DISMISS_FADE_MS, onDismiss)
      return
    }
    const motion = bottomDrawerDismissMotion(offset, velocity, travel, BOTTOM_DRAWER_HIDE_DURATION_MS)
    progress.value = withTiming(
      0,
      { duration: motion.duration, easing: Easing.bezier(motion.x1, motion.y1, 0.2, 1) },
      (finished) => {
        if (finished) runOnJS(onDismiss)()
      }
    )
  }

  return { begin, follow, settle, release, dragging }
}

export function useBottomDrawerDrag(
  args: DrawerMotion & {
    sheetHeight: SharedValue<number>
    screenHeight: number
    scrollOffsetY: SharedValue<number>
    onDismiss: () => void
    dismissible?: boolean
  }
) {
  const { scrollOffsetY } = args
  const dismissible = args.dismissible ?? true
  const drag = useDrawerDrag({ ...args, extent: args.sheetHeight, screenExtent: args.screenHeight })

  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollOffsetY.value = Math.max(event.contentOffset.y, 0)
  })

  const scrollGesture = Gesture.Native()
  const handlePanGesture = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .simultaneousWithExternalGesture(scrollGesture)
    .onBegin(() => {
      if (dismissible) drag.begin()
    })
    .onUpdate((e) => {
      if (dismissible) drag.follow(e.translationY)
    })
    .onEnd((e) => {
      if (dismissible) drag.release(e.velocityY)
    })
  const contentPanGesture = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .simultaneousWithExternalGesture(scrollGesture)
    .onBegin(() => {
      if (dismissible) drag.begin()
    })
    .onUpdate((e) => {
      if (!dismissible) return
      if (scrollOffsetY.value > TOP_SCROLL_EPSILON) {
        if (drag.dragging.value) drag.settle(0)
        return
      }
      drag.follow(e.translationY)
    })
    .onEnd((e) => {
      if (dismissible) drag.release(e.velocityY)
    })

  return { scrollHandler, scrollGesture, handlePanGesture, contentPanGesture }
}
