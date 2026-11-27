import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputInstance,
  type TextInputProps,
  type ViewStyle
} from 'react-native'
import { Search, X } from 'lucide-react-native'
import { colors, feedback, radii, spacing, themedStyleSheet, useColorScheme } from './theme'

const SEARCH_AUTO_FOCUS_DELAY_MS = 120

type SearchFieldProps = {
  value: string
  onChangeText: (text: string) => void
  placeholder: string
  onClear?: () => void
  showClear?: boolean
  clearAccessibilityLabel?: string
  autoFocus?: boolean
  focusKey?: unknown
  returnKeyType?: TextInputProps['returnKeyType']
  onSubmitEditing?: TextInputProps['onSubmitEditing']
  onBlur?: TextInputProps['onBlur']
  onFocus?: TextInputProps['onFocus']
  editable?: boolean
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}

export function SearchField({
  value,
  onChangeText,
  placeholder,
  onClear,
  showClear,
  clearAccessibilityLabel,
  autoFocus = false,
  focusKey,
  returnKeyType = 'search',
  onSubmitEditing,
  onBlur,
  onFocus,
  editable = true,
  accessibilityLabel,
  style
}: SearchFieldProps) {
  useColorScheme()
  const inputRef = useRef<TextInputInstance>(null)
  const [focused, setFocused] = useState(false)
  const clearVisible = showClear ?? value.length > 0

  useEffect(() => {
    if (!autoFocus || !editable) return
    const timeout = setTimeout(() => inputRef.current?.focus(), SEARCH_AUTO_FOCUS_DELAY_MS)
    return () => clearTimeout(timeout)
  }, [autoFocus, editable, focusKey])

  const handleClear = useCallback(() => {
    if (onClear) onClear()
    else onChangeText('')
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [onChangeText, onClear])

  return (
    <View style={[styles.field, focused && styles.focused, !editable && styles.disabled, style]}>
      {editable ? (
        <Pressable
          accessible={false}
          focusable={false}
          tabIndex={-1}
          onPress={() => inputRef.current?.focus()}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View pointerEvents="none">
        <Search size={16} color={colors.textMuted} />
      </View>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.accentBlue}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
        showSoftInputOnFocus
        editable={editable}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        onFocus={(event) => {
          setFocused(true)
          onFocus?.(event)
        }}
        onBlur={(event) => {
          setFocused(false)
          onBlur?.(event)
        }}
        clearButtonMode="never"
        accessibilityLabel={accessibilityLabel ?? placeholder}
        style={styles.fieldText}
      />
      {clearVisible ? (
        <Pressable
          onPress={handleClear}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={clearAccessibilityLabel ?? 'Clear search'}
          style={({ pressed }) => [styles.clearButton, pressed && styles.clearButtonPressed]}
        >
          <View style={styles.clearChip}>
            <X size={12} color={colors.surfaceBright} strokeWidth={2.6} />
          </View>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  field: {
    borderWidth: 1,
    borderColor: colors.inputBorder,
    backgroundColor: colors.composerSurface,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radii.control,
    paddingHorizontal: spacing.md
  },
  focused: {
    borderColor: colors.accentBlue,
    outlineColor: colors.accentBlue,
    outlineStyle: 'solid',
    outlineWidth: 1
  },
  fieldText: {
    outlineWidth: 0,
    position: 'relative',
    flex: 1,
    minWidth: 0,
    alignSelf: 'stretch',
    padding: 0,
    margin: 0,
    fontSize: 16,
    color: colors.textPrimary,
    includeFontPadding: false,
    textAlignVertical: 'center'
  },
  disabled: { opacity: feedback.disabledOpacity },
  clearButton: { marginRight: -spacing.sm, minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  clearButtonPressed: { opacity: feedback.pressedOpacity },
  clearChip: {
    width: 24,
    height: 24,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.textMuted
  }
}))
