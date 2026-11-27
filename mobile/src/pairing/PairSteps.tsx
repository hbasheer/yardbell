import { Text, View } from 'react-native'
import { colors, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'

const STEPS = ['Open Yardbell on your computer', 'Go to Settings > Connect a phone', 'Scan the code']

export function PairSteps() {
  useColorScheme()
  return (
    <View style={styles.steps}>
      {STEPS.map((step, index) => (
        <View key={step} style={styles.step}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{index + 1}</Text>
          </View>
          <Text style={styles.text}>{step}</Text>
        </View>
      ))}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  steps: { marginLeft: 7, gap: spacing.sm, marginBottom: spacing.lg },
  step: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  badge: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgRaised },
  badgeText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  text: { flex: 1, fontSize: 14, color: colors.textSecondary }
}))
