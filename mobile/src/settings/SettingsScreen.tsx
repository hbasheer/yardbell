import { useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import type { ReactNode } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { NavBar } from '@/ui/NavBar'
import { NavBarButton } from '@/ui/NavBarButton'
import { colors, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'

export function SettingsScreen({ title, children }: { title: string; children: ReactNode }) {
  useColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <NavBar
        title={title}
        leading={
          <NavBarButton
            icon={ChevronLeft}
            accessibilityLabel="Back"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          />
        }
      />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}>{children}</ScrollView>
    </View>
  )
}

export function SettingsFooter({ children }: { children: string }) {
  useColorScheme()
  return <Text style={styles.footer}>{children}</Text>
}

const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  footer: { fontSize: 13, lineHeight: 18, color: colors.textSecondary, paddingHorizontal: spacing.lg, paddingTop: spacing.sm }
}))
