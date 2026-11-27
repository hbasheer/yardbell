import { Fragment } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { Folder, Server, SquareTerminal, Zap, type LucideIcon } from 'lucide-react-native'
import { colors, radii, spacing, themedStyleSheet, useColorScheme } from '../../ui/theme'
import type { ItemKind, MenuItem, MenuKind } from './triggers'

const ICON: Record<ItemKind, LucideIcon> = { machine: Server, session: SquareTerminal, folder: Folder, task: Zap }

type Props = { kind: MenuKind; items: MenuItem[]; loading: boolean; onPick: (item: MenuItem) => void }

export function MentionMenu({ kind, items, loading, onPick }: Props) {
  useColorScheme()
  return (
    <View style={styles.menu} accessibilityLabel={kind === 'tasks' ? 'Saved prompts' : 'Machines, sessions and folders'}>
      <ScrollView keyboardShouldPersistTaps="always" nestedScrollEnabled style={styles.scroll}>
        {items.length === 0 ? (
          <Text style={styles.empty}>
            {loading ? 'Loading' : kind === 'tasks' ? 'No saved prompt matches' : 'Nothing by that name'}
          </Text>
        ) : (
          items.map((item, index) => {
            const Icon = ICON[item.kind]
            return (
              <Fragment key={`${item.group}:${item.label}:${index}`}>
                {index === 0 || items[index - 1].group !== item.group ? <Text style={styles.group}>{item.group}</Text> : null}
                <Pressable
                  onPress={() => onPick(item)}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.group}: ${item.label}`}
                  style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                >
                  <Icon size={16} color={colors.textSecondary} />
                  <View style={styles.text}>
                    <Text style={styles.label} numberOfLines={1}>
                      {item.label}
                    </Text>
                    {item.detail ? (
                      <Text style={styles.detail} numberOfLines={1}>
                        {item.detail}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              </Fragment>
            )
          })
        )}
      </ScrollView>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  menu: {
    marginBottom: spacing.sm,
    borderRadius: radii.surface,
    backgroundColor: colors.sheetGroup,
    borderWidth: 1,
    borderColor: colors.composerBorder,
    overflow: 'hidden'
  },
  scroll: { maxHeight: 260 },
  group: { color: colors.textMuted, fontSize: 12, fontWeight: '600', paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm + 2 },
  pressed: { backgroundColor: colors.composerControl },
  text: { flex: 1, minWidth: 0 },
  label: { color: colors.textPrimary, fontSize: 15, fontWeight: '500' },
  detail: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
  empty: { color: colors.textMuted, fontSize: 14, padding: spacing.lg }
}))
