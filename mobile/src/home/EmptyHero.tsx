import { BellRing, QrCode } from 'lucide-react-native'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { colors, radii, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'

const STEPS = [
  { title: 'Open Yardbell on your computer', body: 'Run it on the machine that hosts your agents.' },
  { title: 'Scan the code', body: 'Open Settings, then Connect a phone, and point this phone at the code.' },
  { title: 'You are connected', body: 'Your machines and sessions show up here.' }
]

export function EmptyHero({ onScan, bottomInset }: { onScan: () => void; bottomInset: number }) {
  useColorScheme()
  return (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingBottom: spacing.xl + bottomInset }]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.hero}>
        <BellRing size={44} color={colors.textPrimary} strokeWidth={1.6} />
        <Text style={styles.title}>Connect your computer</Text>
        <Text style={styles.body}>Pair this phone with a Yardbell server to watch and steer your agent sessions.</Text>
      </View>
      <View style={styles.steps}>
        {STEPS.map((step, index) => (
          <View key={step.title} style={[styles.step, index > 0 && styles.stepDivider]}>
            <View style={styles.number}>
              <Text style={styles.numberText}>{index + 1}</Text>
            </View>
            <View style={styles.stepText}>
              <Text style={styles.stepTitle}>{step.title}</Text>
              <Text style={styles.stepBody}>{step.body}</Text>
            </View>
          </View>
        ))}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Scan the pairing code"
        onPress={onScan}
        style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]}
      >
        <QrCode size={18} color={colors.onAccent} strokeWidth={2.2} />
        <Text style={styles.ctaText}>Scan the code</Text>
      </Pressable>
    </ScrollView>
  )
}

const styles = themedStyleSheet(() => ({
  content: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  hero: { alignItems: 'center', marginBottom: 34 },
  title: {
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.4,
    textAlign: 'center',
    color: colors.textPrimary,
    marginTop: 26,
    marginBottom: 10
  },
  body: { fontSize: 17, lineHeight: 24, textAlign: 'center', color: colors.textSecondary },
  steps: { backgroundColor: colors.bgPanel, borderRadius: radii.surface, marginBottom: spacing.xl },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, padding: spacing.lg },
  stepDivider: { borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  number: {
    width: 26,
    height: 26,
    borderRadius: radii.pill,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  numberText: { fontSize: 13, fontWeight: '700', color: colors.textPrimary },
  stepText: { flex: 1, minWidth: 0, gap: 2 },
  stepTitle: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  stepBody: { fontSize: 14, lineHeight: 19, color: colors.textSecondary },
  cta: {
    alignSelf: 'center',
    minHeight: 48,
    paddingHorizontal: 22,
    borderRadius: radii.control,
    backgroundColor: colors.accentBlue,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm
  },
  ctaPressed: { opacity: 0.85, transform: [{ scale: 0.97 }] },
  ctaText: { fontSize: 16, fontWeight: '600', color: colors.onAccent }
}))
