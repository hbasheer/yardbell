import { ImagePlus, Keyboard as KeyboardIcon } from 'lucide-react-native'
import { useRef, useState } from 'react'
import { Pressable, Text, TextInput, View, type TextInputInstance } from 'react-native'
import { colors } from '@/ui/theme'
import { dockStyles as styles } from './dockStyles'
import { DEL, diffToBytes } from './liveInput'

type Props = {
  disabled: boolean
  onBytes: (bytes: string) => void
  onTypedChar: (char: string) => string | null
  onAttach: () => void
  attachBusy: boolean
}

export function LiveInput({ disabled, onBytes, onTypedChar, onAttach, attachBusy }: Props) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const previous = useRef('')
  const input = useRef<TextInputInstance>(null)

  const change = (next: string) => {
    const before = previous.current
    previous.current = next
    setText(next)
    const added = Array.from(next.slice(before.length))
    const modified = next.startsWith(before) && added.length === 1 ? onTypedChar(added[0]) : null
    const bytes = modified ?? diffToBytes(before, next)
    if (bytes) onBytes(bytes)
  }

  const submit = () => {
    onBytes('\r')
    previous.current = ''
    setText('')
  }

  return (
    <View style={styles.inputBar}>
      <Pressable
        style={[styles.liveField, focused && styles.liveFieldFocused]}
        onPress={() => input.current?.focus()}
        accessible={false}
      >
        <KeyboardIcon size={17} color={colors.textSecondary} strokeWidth={2} />
        <View style={styles.liveStack}>
          <Text style={styles.liveLabel}>Live input</Text>
          <TextInput
            ref={input}
            value={text}
            onChangeText={change}
            onSubmitEditing={submit}
            submitBehavior="submit"
            onKeyPress={(event) => {
              if (event.nativeEvent.key === 'Backspace' && previous.current === '') onBytes(DEL)
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            editable={!disabled}
            placeholder="Tap to show keyboard"
            placeholderTextColor={colors.textMuted}
            selectionColor={colors.accentBlue}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            importantForAutofill="no"
            returnKeyType="send"
            accessibilityLabel="Live input"
            accessibilityHint="Everything you type goes straight to the terminal"
            style={styles.liveText}
          />
        </View>
      </Pressable>
      <Pressable
        style={({ pressed }) => [styles.roundButton, pressed && styles.keyPressed, (disabled || attachBusy) && styles.disabled]}
        disabled={disabled || attachBusy}
        onPress={onAttach}
        accessibilityRole="button"
        accessibilityLabel="Attach a photo"
      >
        <ImagePlus size={17} color={colors.textPrimary} strokeWidth={2.4} />
      </Pressable>
    </View>
  )
}
