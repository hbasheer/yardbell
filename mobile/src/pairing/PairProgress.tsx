import { Check } from 'lucide-react-native'
import { ActivityIndicator, Text, View } from 'react-native'
import { colors, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'
import { CenteredMessage } from './PairFrame'

export function PairProgress({ done, title }: { done: boolean; title: string }) {
  useColorScheme()
  return (
    <CenteredMessage title={done ? 'Connected' : title}>
      {done ? (
        <View style={styles.check} accessibilityLabel="Connected">
          <Check size={22} color={colors.bgBase} strokeWidth={3} />
        </View>
      ) : (
        <ActivityIndicator size="large" color={colors.textSecondary} style={styles.spinner} />
      )}
    </CenteredMessage>
  )
}

export function PairError({ message }: { message: string }) {
  useColorScheme()
  return <Text style={styles.error}>{message}</Text>
}

const styles = themedStyleSheet(() => ({
  check: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.statusGreen },
  spinner: { marginTop: spacing.sm },
  error: { fontSize: 14, lineHeight: 20, color: colors.statusRed, textAlign: 'center' }
}))
