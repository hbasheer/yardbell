import { Minus, Plus, Trash2, Undo2 } from 'lucide-react-native'
import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { SwipeCell, type SwipeCellAction } from '../ui/SwipeCell'
import { colors, feedback, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import type { Change, ChangeStatus } from './api'
import { splitPath, statusLetter } from './model'

export const statusColor = (status: ChangeStatus): string =>
  status === 'added' || status === 'untracked' ? colors.gitDecorationAdded : status === 'deleted' ? colors.gitDecorationDeleted : colors.gitDecorationModified

export function ChangeStats({ file }: { file: Pick<Change, 'binary' | 'added' | 'removed'> }) {
  useColorScheme()
  if (file.binary) return <Text style={styles.binary}>binary</Text>
  return (
    <Text style={styles.stats}>
      {file.added ? <Text style={{ color: colors.gitDecorationAdded }}>{`+${file.added}`}</Text> : null}
      {file.added && file.removed ? ' ' : ''}
      {file.removed ? <Text style={{ color: colors.gitDecorationDeleted }}>{`-${file.removed}`}</Text> : null}
    </Text>
  )
}

type Props = {
  file: Change
  busy: boolean
  onOpen: (file: Change) => void
  onMenu: (file: Change) => void
  onToggleStage: (file: Change) => void
  onDiscard: (file: Change) => void
}

export const ChangeRow = memo(function ChangeRow({ file, busy, onOpen, onMenu, onToggleStage, onDiscard }: Props) {
  useColorScheme()
  const { name, dir } = splitPath(file.path)
  const stage: SwipeCellAction = {
    label: file.staged ? 'Unstage' : 'Stage',
    accessibilityLabel: `${file.staged ? 'Unstage' : 'Stage'} ${file.path}`,
    icon: file.staged ? Minus : Plus,
    background: colors.accentBlue,
    foreground: colors.onAccent,
    onPress: () => onToggleStage(file)
  }
  const untracked = file.status === 'untracked'
  const discard: SwipeCellAction | undefined = file.staged
    ? undefined
    : {
        label: untracked ? 'Delete' : 'Discard',
        accessibilityLabel: `${untracked ? 'Delete' : 'Discard changes in'} ${file.path}`,
        icon: untracked ? Trash2 : Undo2,
        background: colors.statusRed,
        foreground: colors.onStatusRed,
        onPress: () => onDiscard(file)
      }
  return (
    <SwipeCell leading={stage} trailing={discard} enabled={!busy}>
      {(guard) => (
        <Pressable
          onPress={guard(() => onOpen(file))}
          onLongPress={() => onMenu(file)}
          delayLongPress={400}
          accessibilityRole="button"
          accessibilityLabel={`${name}, ${file.status}${file.staged ? ', staged' : ''}`}
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        >
          <Text style={[styles.badge, { color: statusColor(file.status) }]}>{statusLetter(file.status)}</Text>
          <View style={styles.text}>
            <Text style={styles.name} numberOfLines={1}>
              {name}
            </Text>
            {dir ? (
              <Text style={styles.dir} numberOfLines={1}>
                {dir}
              </Text>
            ) : null}
          </View>
          <ChangeStats file={file} />
        </Pressable>
      )}
    </SwipeCell>
  )
})

const styles = themedStyleSheet(() => ({
  row: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    backgroundColor: colors.bgBase,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  pressed: { backgroundColor: colors.bgPanel, opacity: feedback.pressedOpacity },
  badge: { width: 24, fontFamily: typography.monoFamily, fontSize: typography.metaSize, fontWeight: '700' },
  text: { flex: 1, minWidth: 0 },
  name: { fontSize: typography.bodySize, color: colors.textPrimary },
  dir: { fontSize: typography.metaSize, color: colors.textMuted, marginTop: 2 },
  stats: { fontSize: typography.metaSize, fontFamily: typography.monoFamily, color: colors.textMuted },
  binary: { fontSize: typography.metaSize, color: colors.textMuted }
}))
