import { Clipboard as ClipboardIcon, ChevronDown, Keyboard as KeyboardIcon, Plus } from 'lucide-react-native'
import { useEffect, useRef, type ReactNode } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { colors } from '@/ui/theme'
import type { CustomKey } from './customKeys'
import { dockStyles as styles, KEY_HIT_SLOP } from './dockStyles'
import { KEY_DEFS, KEY_DEFS_AFTER_LATCHES, type KeyDef } from './keyDefs'
import { DOUBLE_TAP_MS, type LatchName, type Latches } from './latches'

const REPEAT_DELAY_MS = 400
const REPEAT_INTERVAL_MS = 45
const LATCHES: { id: LatchName; label: string; a11y: string }[] = [
  { id: 'shift', label: 'Shift', a11y: 'Shift' },
  { id: 'ctrl', label: 'Ctrl', a11y: 'Control' },
  { id: 'alt', label: 'Alt', a11y: 'Alt' }
]

type Props = {
  latches: Latches
  keyboardUp: boolean
  smart?: ReactNode
  customKeys: CustomKey[]
  disabled: boolean
  onDismissKeyboard: () => void
  onPaste: () => void
  onLatch: (name: LatchName, doubleTap: boolean) => void
  onKey: (def: KeyDef) => void
  onCustom: (key: CustomKey) => void
  onDeleteCustom: (key: CustomKey) => void
  onAddCustom: () => void
}

export function KeyRow({
  latches,
  keyboardUp,
  smart,
  customKeys,
  disabled,
  onDismissKeyboard,
  onPaste,
  onLatch,
  onKey,
  onCustom,
  onDeleteCustom,
  onAddCustom
}: Props) {
  const lastTap = useRef<{ name: LatchName; at: number } | null>(null)
  const repeat = useRef<{ delay?: ReturnType<typeof setTimeout>; every?: ReturnType<typeof setInterval> }>({})

  const stopRepeat = () => {
    clearTimeout(repeat.current.delay)
    clearInterval(repeat.current.every)
    repeat.current = {}
  }
  useEffect(() => stopRepeat, [])

  const startRepeat = (def: KeyDef) => {
    stopRepeat()
    onKey(def)
    repeat.current.delay = setTimeout(() => {
      repeat.current.every = setInterval(() => onKey(def), REPEAT_INTERVAL_MS)
    }, REPEAT_DELAY_MS)
  }

  const tapLatch = (name: LatchName) => {
    const now = Date.now()
    const previous = lastTap.current
    const doubleTap = previous !== null && previous.name === name && now - previous.at <= DOUBLE_TAP_MS
    lastTap.current = doubleTap ? null : { name, at: now }
    onLatch(name, doubleTap)
  }

  const builtIn = (def: KeyDef) => (
    <Pressable
      key={def.id}
      style={({ pressed }) => [styles.key, pressed && styles.keyPressed, disabled && styles.disabled]}
      disabled={disabled}
      hitSlop={KEY_HIT_SLOP}
      onPressIn={def.repeatable ? () => startRepeat(def) : undefined}
      onPressOut={def.repeatable ? stopRepeat : undefined}
      onPress={def.repeatable ? undefined : () => onKey(def)}
      accessibilityRole="button"
      accessibilityLabel={def.a11y}
    >
      <Text style={styles.keyText}>{def.label}</Text>
    </Pressable>
  )

  return (
    <View style={styles.keyRow}>
      {keyboardUp ? (
        <Pressable
          style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          hitSlop={KEY_HIT_SLOP}
          onPress={onDismissKeyboard}
          accessibilityRole="button"
          accessibilityLabel="Dismiss keyboard"
        >
          <KeyboardIcon size={15} color={colors.textPrimary} strokeWidth={2} />
          <ChevronDown size={10} color={colors.textPrimary} strokeWidth={2.4} />
        </Pressable>
      ) : null}
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        style={styles.keyScroll}
        contentContainerStyle={styles.keyScrollContent}
      >
        {smart}
        <Pressable
          style={({ pressed }) => [styles.key, pressed && styles.keyPressed, disabled && styles.disabled]}
          disabled={disabled}
          hitSlop={KEY_HIT_SLOP}
          onPress={onPaste}
          accessibilityRole="button"
          accessibilityLabel="Paste"
        >
          <ClipboardIcon size={15} color={colors.textPrimary} strokeWidth={2} />
          <Text style={styles.keyText}>Paste</Text>
        </Pressable>
        {KEY_DEFS.map(builtIn)}
        {LATCHES.map(({ id, label, a11y }) => {
          const latch = latches[id]
          return (
            <Pressable
              key={id}
              style={({ pressed }) => [
                styles.key,
                styles.keyLatch,
                latch === 'once' && styles.keyLatched,
                latch === 'locked' && styles.keyLocked,
                pressed && styles.keyPressed,
                disabled && styles.disabled
              ]}
              disabled={disabled}
              hitSlop={KEY_HIT_SLOP}
              onPress={() => tapLatch(id)}
              accessibilityRole="button"
              accessibilityLabel={a11y}
              accessibilityState={{ selected: latch !== 'off' }}
            >
              <Text style={[styles.keyText, latch === 'locked' && styles.keyTextLocked]}>{label}</Text>
            </Pressable>
          )
        })}
        {KEY_DEFS_AFTER_LATCHES.map(builtIn)}
        {customKeys.map((custom) => (
          <Pressable
            key={custom.id}
            style={({ pressed }) => [styles.key, styles.customKey, pressed && styles.keyPressed, disabled && styles.disabled]}
            disabled={disabled}
            hitSlop={KEY_HIT_SLOP}
            onPress={() => onCustom(custom)}
            onLongPress={() => onDeleteCustom(custom)}
            accessibilityRole="button"
            accessibilityLabel={custom.label}
            accessibilityHint="Long press to delete"
          >
            <Text style={styles.keyText}>{custom.label}</Text>
          </Pressable>
        ))}
        <Pressable
          style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          hitSlop={KEY_HIT_SLOP}
          onPress={onAddCustom}
          accessibilityRole="button"
          accessibilityLabel="Add custom key"
        >
          <Plus size={15} color={colors.textPrimary} strokeWidth={2} />
        </Pressable>
      </ScrollView>
    </View>
  )
}
