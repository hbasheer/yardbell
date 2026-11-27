import { Fragment, isValidElement, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronLeft, X } from 'lucide-react-native'
import { NAV_BAR_BUTTON_SIZE, NavBarButton, NavBarButtonOnSheetContext } from './NavBarButton'
import { colors, feedback, radii, spacing, themedStyleSheet, useColorScheme } from './theme'

type SheetTextAction = { label: string; onPress: () => void; disabled?: boolean; busy?: boolean }

type SheetHeaderProps = {
  title: string
  titleAboveActions?: boolean
  subtitle?: string
  leading?: SheetTextAction
  onBack?: { label: string; onPress: () => void }
  leadingButton?: ReactNode
  trailing?: SheetTextAction
  onClose?: () => void
  trailingButtons?: ReactNode
}

function oneButton(node: ReactNode): boolean {
  return isValidElement(node) && node.type !== Fragment
}

export function SheetHeader({
  title,
  subtitle,
  leading,
  onBack,
  leadingButton,
  trailing,
  onClose,
  trailingButtons,
  titleAboveActions
}: SheetHeaderProps) {
  useColorScheme()
  const narrow =
    !leading &&
    !trailing &&
    (leadingButton === undefined || oneButton(leadingButton)) &&
    (trailingButtons === undefined || oneButton(trailingButtons))
  const side = [styles.side, narrow && styles.sideNarrow]
  return (
    <NavBarButtonOnSheetContext value={true}>
      <View>
        {titleAboveActions ? (
          <View style={styles.heading}>
            <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
              {title}
            </Text>
            {subtitle !== undefined ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
        ) : null}
        <View style={styles.header}>
          <View style={side}>
            {leading ? (
              <TextAction action={leading} emphasis={false} />
            ) : onBack ? (
              <NavBarButton icon={ChevronLeft} accessibilityLabel={onBack.label} onPress={onBack.onPress} />
            ) : (
              (leadingButton ?? null)
            )}
          </View>
          {!titleAboveActions ? (
            <View style={styles.center}>
              {title ? (
                <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
                  {title}
                </Text>
              ) : null}
              {subtitle !== undefined ? (
                <Text style={styles.subtitle} numberOfLines={1}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
          ) : (
            <View style={styles.center} />
          )}
          <View style={[...side, styles.trailing]}>
            {trailing ? <TextAction action={trailing} emphasis /> : (trailingButtons ?? null)}
            {onClose && !trailing && !trailingButtons ? (
              <NavBarButton icon={X} accessibilityLabel="Close" onPress={onClose} />
            ) : null}
          </View>
        </View>
      </View>
    </NavBarButtonOnSheetContext>
  )
}

function TextAction({ action, emphasis }: { action: SheetTextAction; emphasis: boolean }) {
  useColorScheme()
  return (
    <Pressable
      onPress={action.onPress}
      disabled={action.disabled || action.busy}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ disabled: action.disabled === true, busy: action.busy === true }}
      style={({ pressed }) => [styles.action, pressed && styles.actionPressed, action.disabled && styles.actionDisabled]}
    >
      {action.busy ? (
        <ActivityIndicator size="small" color={colors.textPrimary} />
      ) : (
        <Text style={[styles.actionLabel, emphasis && styles.actionEmphasis]} numberOfLines={1}>
          {action.label}
        </Text>
      )}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  heading: { alignItems: 'center', paddingTop: spacing.sm, paddingHorizontal: spacing.md },
  header: { height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xs },
  side: { width: 84, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sideNarrow: { width: NAV_BAR_BUTTON_SIZE + spacing.sm },
  trailing: { justifyContent: 'flex-end' },
  center: { flex: 1, minWidth: 0, alignItems: 'center' },
  title: { color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
  subtitle: { color: colors.textSecondary, fontSize: 12 },
  action: { minHeight: 44, paddingHorizontal: spacing.md, borderRadius: radii.control, justifyContent: 'center' },
  actionPressed: { backgroundColor: colors.translucentFill },
  actionDisabled: { opacity: feedback.disabledOpacity },
  actionLabel: { color: colors.textPrimary, fontSize: 16 },
  actionEmphasis: { fontWeight: '600' }
}))
