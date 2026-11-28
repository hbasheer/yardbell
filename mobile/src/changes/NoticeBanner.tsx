import { CircleAlert, Info, X } from 'lucide-react-native'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import type { Notice } from './useChangesActions'

export function NoticeBanner({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  useColorScheme()
  const error = notice.kind === 'error'
  const Icon = error ? CircleAlert : Info
  return (
    <View style={[styles.banner, error && styles.error]} accessibilityRole="alert">
      <Icon size={15} color={error ? colors.statusRed : colors.textSecondary} strokeWidth={2} style={styles.icon} />
      <ScrollView style={styles.scroll} nestedScrollEnabled>
        <Text style={[styles.text, error && styles.errorText]} selectable>
          {notice.text}
        </Text>
      </ScrollView>
      <Pressable onPress={onDismiss} hitSlop={10} accessibilityRole="button" accessibilityLabel="Dismiss">
        <X size={16} color={colors.textSecondary} strokeWidth={2.2} />
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  error: { borderWidth: 1, borderColor: colors.statusRed },
  icon: { marginTop: 2 },
  scroll: { flex: 1, maxHeight: 240 },
  text: { fontSize: typography.metaSize + 1, lineHeight: 18, color: colors.textSecondary },
  errorText: { color: colors.textPrimary, fontFamily: typography.monoFamily, fontSize: typography.metaSize }
}))
