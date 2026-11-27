import { Pressable, Text, View } from 'react-native'
import { colors, radii, spacing, themedStyleSheet, useColorScheme } from '../ui/theme'
import { triggerSelection } from '../ui/haptics'

const COLUMNS = 3

export type AgentOption = { name: string; label: string }

export function AgentTiles({
  agents,
  selected,
  onPick
}: {
  agents: AgentOption[]
  selected: string
  onPick: (name: string) => void
}) {
  useColorScheme()
  const rows: AgentOption[][] = []
  for (let start = 0; start < agents.length; start += COLUMNS) rows.push(agents.slice(start, start + COLUMNS))
  return (
    <View style={styles.grid}>
      {rows.map((row) => (
        <View key={row.map((agent) => agent.name).join(':')} style={styles.row}>
          {row.map((agent) => {
            const on = agent.name === selected
            return (
              <Pressable
                key={agent.name}
                onPress={() => {
                  triggerSelection()
                  onPick(agent.name)
                }}
                accessibilityRole="radio"
                accessibilityLabel={agent.label}
                accessibilityState={{ selected: on, checked: on }}
                style={[styles.tile, on && styles.tileOn]}
              >
                {({ pressed }) => (
                  <>
                    {pressed ? <View style={styles.pressed} /> : null}
                    <View style={styles.mark}>
                      <Text style={styles.markLetter}>{agent.label.slice(0, 1).toUpperCase()}</Text>
                    </View>
                    <Text style={styles.label} numberOfLines={1}>
                      {agent.label}
                    </Text>
                  </>
                )}
              </Pressable>
            )
          })}
          {Array.from({ length: COLUMNS - row.length }, (_, index) => (
            <View key={`empty:${index}`} style={styles.spacer} />
          ))}
        </View>
      ))}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  grid: { gap: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.sm },
  tile: {
    flex: 1,
    minWidth: 0,
    height: 78,
    borderRadius: radii.surface,
    backgroundColor: colors.sheetGroup,
    borderWidth: 1,
    borderColor: 'transparent',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm
  },
  tileOn: { borderColor: colors.textSecondary },
  pressed: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.translucentFill },
  mark: {
    width: 22,
    height: 22,
    borderRadius: radii.mark + 2,
    backgroundColor: colors.translucentFill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  markLetter: { fontSize: 12, fontWeight: '700', color: colors.textPrimary },
  label: { fontSize: 13.5, fontWeight: '600', color: colors.textPrimary, maxWidth: '100%' },
  spacer: { flex: 1, paddingHorizontal: spacing.sm }
}))
