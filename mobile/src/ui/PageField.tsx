import { TextInput, type TextInputProps } from 'react-native'
import { colors, radii, spacing, themedStyleSheet, useColorScheme } from './theme'

export function PageField(props: TextInputProps) {
  useColorScheme()
  return <TextInput placeholderTextColor={colors.textMuted} {...props} style={[styles.field, props.style]} />
}

const styles = themedStyleSheet(() => ({
  field: {
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    fontSize: 15
  }
}))
