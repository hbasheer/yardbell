import { Monitor, Server } from 'lucide-react-native'
import { Text, View } from 'react-native'
import type { MachineRow } from '@/state/views'
import { machineSubtitle } from './presentation'
import { ListRow } from '@/ui/ListRow'
import { statusDotColor, type ConnectionState } from '@/ui/StatusDot'
import { colors, fixedColors, radii, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'

export const MACHINE_SEPARATOR_INSET = spacing.lg + 30 + spacing.md

const DOT_STATE: Record<MachineRow['status'], ConnectionState> = {
  up: 'connected',
  reconnecting: 'reconnecting',
  unreachable: 'unreachable',
  down: 'disconnected'
}

function problemColor(status: MachineRow['status']): string | undefined {
  if (status === 'unreachable' || status === 'down') return colors.statusRed
  if (status === 'reconnecting') return colors.statusAmber
  return undefined
}

export function MachineRowItem({
  row,
  local,
  onOpen,
  onMenu
}: {
  row: MachineRow
  local: boolean
  onOpen: (row: MachineRow) => void
  onMenu: (row: MachineRow) => void
}) {
  useColorScheme()
  const Icon = local ? Monitor : Server
  return (
    <ListRow
      title={row.machine}
      subtitle={machineSubtitle(row)}
      subtitleColor={problemColor(row.status)}
      leading={
        <View style={styles.tile}>
          <Icon size={17} color={colors.textPrimary} strokeWidth={1.8} />
          <View style={[styles.dot, { backgroundColor: statusDotColor(DOT_STATE[row.status]) }]} />
        </View>
      }
      accessory={
        row.needsYou > 0 ? (
          <View style={styles.pill}>
            <Text style={styles.pillText}>{row.needsYou}</Text>
          </View>
        ) : undefined
      }
      navigates
      onPress={() => onOpen(row)}
      onLongPress={() => onMenu(row)}
      accessibilityLabel={`${row.machine}, ${machineSubtitle(row)}`}
    />
  )
}

const styles = themedStyleSheet(() => ({
  tile: {
    width: 30,
    height: 30,
    borderRadius: radii.tile,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  dot: {
    position: 'absolute',
    right: -5,
    bottom: -5,
    width: 10,
    height: 10,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.bgPanel
  },
  pill: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.statusAmber,
    alignItems: 'center',
    justifyContent: 'center'
  },
  pillText: { fontSize: 12, fontWeight: '700', color: fixedColors.black }
}))
