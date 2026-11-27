import { useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'
import { NavBarButton } from '@/ui/NavBarButton'

export function PairFrame({ children, back = true }: { children: ReactNode; back?: boolean }) {
  useColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.frame, { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.sm }]}>
      {back && router.canGoBack() ? (
        <View style={styles.back}>
          <NavBarButton icon={ChevronLeft} accessibilityLabel="Back" onPress={() => router.back()} />
        </View>
      ) : null}
      {children}
    </View>
  )
}

export function CenteredMessage({ title, titleLines, message, children }: { title: string; titleLines?: number; message?: string; children?: ReactNode }) {
  useColorScheme()
  return (
    <View style={styles.centered}>
      <Text style={styles.title} numberOfLines={titleLines}>{title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {children}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  frame: { flex: 1, paddingHorizontal: spacing.lg, backgroundColor: colors.bgBase },
  back: { alignItems: 'flex-start', marginBottom: spacing.sm },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm, paddingBottom: 48, gap: spacing.sm },
  title: { fontSize: 18, fontWeight: '600', color: colors.textPrimary, textAlign: 'center' },
  message: { fontSize: 14, lineHeight: 20, color: colors.textSecondary, textAlign: 'center', maxWidth: 310 }
}))
