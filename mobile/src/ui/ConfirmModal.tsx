import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { BottomDrawer } from './BottomDrawer'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from './theme'

type ContentProps = {
  media?: ReactNode
  title: string
  message?: string
  details?: ReactNode
  confirmLabel?: string
  cancelLabel?: string | null
  destructive?: boolean
  onConfirm?: () => void
  onCancelPress?: () => void
  onCancel: () => void
}

type Props = ContentProps & { visible: boolean }

export function ConfirmModal({ visible, ...content }: Props) {
  return (
    <BottomDrawer visible={visible} onClose={content.onCancel}>
      <ConfirmContent {...content} />
    </BottomDrawer>
  )
}

export function ConfirmContent({
  media,
  title,
  message,
  details,
  confirmLabel,
  cancelLabel,
  destructive = false,
  onConfirm,
  onCancelPress,
  onCancel
}: ContentProps) {
  useColorScheme()
  return (
    <>
      <View style={styles.content}>
        {media ? <View style={styles.media}>{media}</View> : null}
        <Text style={[styles.title, media ? styles.centred : null]}>{title}</Text>
        {message ? <Text style={[styles.message, media ? styles.centred : null]}>{message}</Text> : null}
        {details}
      </View>
      <View style={styles.buttons}>
        {cancelLabel === null ? null : (
          <Pressable
            style={({ pressed }) => [styles.button, styles.cancelButton, pressed && styles.pressed]}
            onPress={() => {
              onCancelPress?.()
              onCancel()
            }}
          >
            <Text style={styles.cancelText}>{cancelLabel ?? 'Cancel'}</Text>
          </Pressable>
        )}
        <Pressable
          style={({ pressed }) => [
            styles.button,
            destructive ? styles.destructiveButton : styles.confirmButton,
            pressed && styles.pressed
          ]}
          onPress={() => {
            onConfirm?.()
            onCancel()
          }}
        >
          <Text style={destructive ? styles.destructiveText : styles.confirmText}>{confirmLabel ?? 'Confirm'}</Text>
        </Pressable>
      </View>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  content: { paddingBottom: spacing.lg },
  media: { alignItems: 'center', marginBottom: spacing.md },
  centred: { textAlign: 'center' },
  title: { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
  message: { fontSize: typography.bodySize, color: colors.textSecondary, marginTop: spacing.xs, lineHeight: 20 },
  buttons: { flexDirection: 'row', gap: spacing.sm },
  button: { flex: 1, paddingVertical: spacing.sm + 2, borderRadius: radii.control, alignItems: 'center' },
  cancelButton: { backgroundColor: colors.sheetGroup },
  confirmButton: { backgroundColor: colors.textPrimary },
  destructiveButton: { backgroundColor: colors.statusRed },
  pressed: { opacity: 0.7 },
  cancelText: { fontSize: typography.bodySize, fontWeight: '600', color: colors.textSecondary },
  confirmText: { fontSize: typography.bodySize, fontWeight: '600', color: colors.bgBase },
  destructiveText: { fontSize: typography.bodySize, fontWeight: '600', color: colors.onStatusRed }
}))
