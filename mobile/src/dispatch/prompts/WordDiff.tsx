import { Text, View } from 'react-native'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../../ui/theme'
import type { PromptDiff } from '../types'

export function WordDiff({ parts }: { parts: PromptDiff['parts'] }) {
  useColorScheme()
  return (
    <View style={styles.frame} accessibilityLabel="Changes">
      <Text style={styles.text} selectable>
        {parts.map((part, at) => (
          <Text
            key={at}
            style={part.op === 'add' ? styles.added : part.op === 'del' ? styles.deleted : undefined}
            accessibilityLabel={part.op === 'add' ? `added ${part.text}` : part.op === 'del' ? `removed ${part.text}` : undefined}
          >
            {part.text}
          </Text>
        ))}
      </Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  frame: { padding: spacing.md, borderRadius: radii.control, borderWidth: 1, borderColor: colors.borderSubtle, backgroundColor: colors.bgRaised },
  text: { fontFamily: typography.monoFamily, fontSize: 12.5, lineHeight: 20, color: colors.textSecondary },
  added: { backgroundColor: colors.diffAddedBg, color: colors.diffAddedSign },
  deleted: { backgroundColor: colors.diffDeletedBg, color: colors.diffDeletedSign }
}))
