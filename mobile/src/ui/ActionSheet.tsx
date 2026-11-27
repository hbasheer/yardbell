import { useRef, type ReactNode } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { Edit3, Trash2, type LucideIcon } from 'lucide-react-native'
import { BottomDrawer } from './BottomDrawer'
import { LIST_LEADING_INSET, LIST_ROW_PADDING, ListGroup } from './ListGroup'
import { ListRow } from './ListRow'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from './theme'

export type ActionSheetAction = {
  id?: string
  label: string
  icon?: LucideIcon
  renderIcon?: () => ReactNode
  destructive?: boolean
  disabled?: boolean
  hint?: string
  status?: string
  checked?: boolean
  loading?: boolean
  skipAutoClose?: boolean
  closeBeforePress?: boolean
  onPress: () => void
}

type Props = {
  visible: boolean
  title?: ReactNode
  titleAccessibilityLabel?: string
  message?: string
  headerIcon?: ReactNode
  groupDestructive?: boolean
  actions: ActionSheetAction[]
  onClose: () => void
  onAfterClose?: () => void
}

function iconForAction(label: string, destructive?: boolean, icon?: LucideIcon): LucideIcon {
  if (icon) return icon
  if (destructive || /delete|remove/i.test(label)) return Trash2
  return Edit3
}

type ContentProps = {
  title?: ReactNode
  titleAccessibilityLabel?: string
  message?: string
  headerIcon?: ReactNode
  groupDestructive?: boolean
  children?: ReactNode
  actions: ActionSheetAction[]
  onClose?: () => void
}

export function ActionSheetContent({
  title,
  titleAccessibilityLabel,
  message,
  headerIcon,
  groupDestructive = false,
  children,
  actions,
  onClose
}: ContentProps) {
  useColorScheme()
  const groups = (
    groupDestructive
      ? [
          { key: 'actions', actions: actions.filter((action) => !action.destructive) },
          { key: 'destructive', actions: actions.filter((action) => action.destructive) }
        ]
      : [{ key: 'actions', actions }]
  ).filter((group) => group.actions.length > 0)
  return (
    <>
      {headerIcon ? (
        <View style={[styles.header, styles.subjectHeader]}>
          <View style={styles.subjectTile}>{headerIcon}</View>
          <View style={styles.subjectText}>
            {title ? (
              <Text style={styles.subjectTitle} numberOfLines={1} accessibilityRole="header" accessibilityLabel={titleAccessibilityLabel}>
                {title}
              </Text>
            ) : null}
            {message ? (
              <Text style={styles.subjectMessage} numberOfLines={1}>
                {message}
              </Text>
            ) : null}
          </View>
        </View>
      ) : (
        (title || message) && (
          <View style={styles.header}>
            {title ? (
              <Text style={styles.title} numberOfLines={1} accessibilityLabel={titleAccessibilityLabel}>
                {title}
              </Text>
            ) : null}
            {message ? <Text style={styles.message}>{message}</Text> : null}
          </View>
        )
      )}

      {children}

      {groups.map((group, index) => (
        <ListGroup key={group.key} separatorInset={LIST_LEADING_INSET} style={index > 0 ? styles.laterGroup : undefined}>
          {group.actions.map((action) => {
            const Icon = iconForAction(action.label, action.destructive, action.icon)
            return (
              <ListRow
                key={action.id ?? action.label}
                title={action.label}
                subtitle={action.hint}
                value={action.status}
                leading={
                  action.renderIcon?.() ?? (
                    <Icon size={16} color={action.destructive ? colors.statusRed : colors.textSecondary} />
                  )
                }
                accessory={action.loading ? <ActivityIndicator size="small" color={colors.textSecondary} /> : undefined}
                selected={action.checked ? true : undefined}
                destructive={action.destructive}
                disabled={action.disabled}
                busy={action.loading}
                onPress={() => {
                  action.onPress()
                  if (!action.skipAutoClose && onClose) onClose()
                }}
              />
            )
          })}
        </ListGroup>
      ))}
    </>
  )
}

export function ActionSheet({
  visible,
  title,
  titleAccessibilityLabel,
  message,
  headerIcon,
  groupDestructive,
  actions,
  onClose,
  onAfterClose
}: Props) {
  const pendingActionRef = useRef<(() => void) | null>(null)
  const sequencedActions = actions.map((action) =>
    action.closeBeforePress
      ? {
          ...action,
          onPress: () => {
            pendingActionRef.current = action.onPress
          }
        }
      : action
  )

  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      onAfterClose={() => {
        const pendingAction = pendingActionRef.current
        pendingActionRef.current = null
        pendingAction?.()
        onAfterClose?.()
      }}
      dragContentToDismiss
    >
      <ActionSheetContent
        title={title}
        titleAccessibilityLabel={titleAccessibilityLabel}
        message={message}
        headerIcon={headerIcon}
        groupDestructive={groupDestructive}
        actions={sequencedActions}
        onClose={onClose}
      />
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  header: { paddingHorizontal: LIST_ROW_PADDING, paddingBottom: spacing.sm },
  title: { fontSize: 13, fontWeight: '500', color: colors.textSecondary },
  message: { fontSize: typography.metaSize, color: colors.textMuted, marginTop: 2 },
  subjectHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingBottom: spacing.md },
  subjectTile: {
    width: 34,
    height: 34,
    borderRadius: radii.tile,
    backgroundColor: colors.translucentFill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  subjectText: { flex: 1, minWidth: 0, gap: 2 },
  subjectTitle: { fontSize: 16, fontWeight: '600', color: colors.textPrimary },
  subjectMessage: { fontSize: 13, color: colors.textSecondary },
  laterGroup: { marginTop: spacing.md }
}))
