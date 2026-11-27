import { useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { CircleAlert, SearchX, WifiOff, type LucideIcon } from 'lucide-react-native'
import {
  colors,
  feedback,
  pressedStyle,
  radii,
  spacing,
  themedStyleSheet,
  typography,
  useColorScheme
} from './theme'

export type StateAction = { label: string; onPress: () => void }

type StateViewProps = {
  icon?: LucideIcon
  iconElement?: ReactNode
  title: string
  message?: string | null
  details?: string | null
  action?: StateAction | null
  secondaryAction?: StateAction | null
  loading?: boolean
  bottomInset?: number
  children?: ReactNode
}

export function StateView({
  icon: Icon,
  iconElement,
  title,
  message,
  details,
  action,
  secondaryAction,
  loading = false,
  bottomInset = 0,
  children
}: StateViewProps) {
  useColorScheme()
  return (
    <View style={[styles.state, { paddingBottom: spacing.xl + bottomInset }]}>
      {loading ? (
        <ActivityIndicator size="small" color={colors.textSecondary} />
      ) : Icon ? (
        <Icon size={24} color={colors.textMuted} strokeWidth={1.75} />
      ) : (
        iconElement
      )}
      <Text style={loading ? styles.message : styles.title}>{title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {details ? <StateDetails details={details} /> : null}
      {action && secondaryAction ? (
        <View style={styles.actions}>
          <StateButton label={secondaryAction.label} onPress={secondaryAction.onPress} />
          <StateButton label={action.label} onPress={action.onPress} />
        </View>
      ) : action ? (
        <StateButton label={action.label} onPress={action.onPress} />
      ) : null}
      {children ? <View style={styles.children}>{children}</View> : null}
    </View>
  )
}

export function StateButton({
  label,
  onPress,
  disabled,
  inRow = false,
  accessibilityLabel
}: StateAction & { disabled?: boolean; inRow?: boolean; accessibilityLabel?: string }) {
  useColorScheme()
  return (
    <Pressable
      style={({ pressed }) => [
        styles.action,
        inRow && styles.actionInRow,
        pressed && styles.actionPressed,
        disabled && styles.actionDisabled
      ]}
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
    >
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  )
}

function StateDetails({ details }: { details: string }) {
  useColorScheme()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Pressable
        style={({ pressed }) => pressed && pressedStyle}
        onPress={() => setOpen(!open)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Text style={styles.detailsToggle}>{open ? 'Hide details' : 'Details'}</Text>
      </Pressable>
      {open ? (
        <Text style={styles.details} selectable>
          {details}
        </Text>
      ) : null}
    </>
  )
}

export function LoadErrorState({
  message,
  details,
  title,
  onRetry,
  bottomInset
}: {
  message: string
  details?: string | null
  title?: string
  onRetry?: (() => void) | null
  bottomInset?: number
}) {
  return (
    <StateView
      icon={CircleAlert}
      title={title ?? 'Unable to load'}
      message={message}
      details={details}
      action={onRetry ? { label: 'Retry', onPress: onRetry } : null}
      bottomInset={bottomInset}
    />
  )
}

export function OfflineState({
  machineName,
  message,
  onReconnect,
  bottomInset
}: {
  machineName?: string | null
  message?: string
  onReconnect?: (() => void) | null
  bottomInset?: number
}) {
  return (
    <StateView
      icon={WifiOff}
      title={machineName ? `Waiting for ${machineName}` : 'Waiting for machine'}
      message={message ?? 'Check that the machine is awake and Yardbell is running.'}
      action={onReconnect ? { label: 'Reconnect', onPress: onReconnect } : null}
      bottomInset={bottomInset}
    />
  )
}

export function NoMatchState({
  message,
  onClear,
  clearLabel,
  bottomInset
}: {
  message?: string
  onClear?: (() => void) | null
  clearLabel?: string
  bottomInset?: number
}) {
  return (
    <StateView
      icon={SearchX}
      title="No matches"
      message={message}
      action={onClear ? { label: clearLabel ?? 'Clear search', onPress: onClear } : null}
      bottomInset={bottomInset}
    />
  )
}

const styles = themedStyleSheet(() => ({
  children: { alignSelf: 'stretch', marginTop: spacing.md },
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: 6 },
  title: { marginTop: spacing.xs, color: colors.textPrimary, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  message: { maxWidth: 280, color: colors.textSecondary, fontSize: 13, lineHeight: 17, textAlign: 'center' },
  detailsToggle: { color: colors.textMuted, fontSize: typography.metaSize, fontWeight: '600', paddingVertical: 2 },
  details: {
    maxWidth: 300,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 15,
    fontFamily: typography.monoFamily,
    textAlign: 'center'
  },
  action: {
    marginTop: spacing.sm,
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: radii.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  actionInRow: { marginTop: 0, borderColor: colors.floatingCardBorder },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.sm },
  actionPressed: { opacity: feedback.pressedOpacity },
  actionDisabled: { opacity: 0.5 },
  actionText: { color: colors.textPrimary, fontSize: 13, fontWeight: '600' }
}))
