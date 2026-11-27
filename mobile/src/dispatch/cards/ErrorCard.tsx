import { Text, View } from 'react-native'
import { TriangleAlert } from 'lucide-react-native'
import { colors, radii, spacing, themedStyleSheet, useColorScheme } from '../../ui/theme'

export function ErrorCard({ text }: { text: string }) {
  useColorScheme()
  return (
    <View style={styles.box} accessibilityRole="alert">
      <TriangleAlert size={16} color={colors.statusRed} strokeWidth={2.2} style={styles.icon} />
      <Text style={styles.text} selectable>
        {text}
      </Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  box: {
    flexDirection: 'row',
    gap: 10,
    padding: spacing.md,
    borderRadius: radii.surface,
    borderWidth: 1,
    borderColor: colors.statusRed
  },
  icon: { marginTop: 3 },
  text: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 22, color: colors.textPrimary }
}))
