import { type ReactNode } from 'react'
import { Text, View } from 'react-native'
import { LoadErrorState, StateView } from '../../ui/StateView'
import { colors, spacing, themedStyleSheet, typography, useColorScheme } from '../../ui/theme'

export function Loading({ title }: { title: string }) {
  return (
    <View style={{ paddingTop: 80 }}>
      <StateView loading title={title} />
    </View>
  )
}

export function Failed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={{ paddingTop: 40 }}>
      <LoadErrorState message={message} onRetry={onRetry} />
    </View>
  )
}

export function Help({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' | 'error' }) {
  useColorScheme()
  return <Text style={[styles.help, tone === 'warn' && styles.warn, tone === 'error' && styles.error]}>{children}</Text>
}

export const messageOf = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback)

const styles = themedStyleSheet(() => ({
  help: { fontSize: 13, lineHeight: 18, color: colors.textSecondary, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  warn: { color: colors.statusAmber },
  error: { color: colors.statusRed, fontFamily: typography.monoFamily }
}))
