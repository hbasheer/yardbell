import { Plus, Settings } from 'lucide-react-native'
import { RefreshControl, ScrollView, Text, View } from 'react-native'
import { feedSections, machineRows, type MachineRow, type ServerSession, type ServerState } from '@/state/views'
import { LIST_LEADING_INSET, ListGroup } from '@/ui/ListGroup'
import { ListRow } from '@/ui/ListRow'
import { colors, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'
import { AgentRow } from './AgentRow'
import { HomeHeader, HeaderIconButton } from './HomeHeader'
import { HomeSectionHeading } from './HomeSectionHeading'
import { MACHINE_SEPARATOR_INSET, MachineRowItem } from './MachineRowItem'

type Props = {
  servers: ServerState[]
  bottomPad: number
  refreshing: boolean
  onRefresh: () => void
  onOpenSettings: () => void
  onOpenSession: (session: ServerSession) => void
  onOpenMachine: (row: MachineRow) => void
  onMachineMenu: (row: MachineRow) => void
  onSeeAll: () => void
  onPair: () => void
}

export function FeedTab(props: Props) {
  useColorScheme()
  const sections = feedSections(props.servers)
  const rows = machineRows(props.servers)
  const isLocal = (row: MachineRow) =>
    props.servers.find((s) => s.server.id === row.serverId)?.state?.machines.find((m) => m.name === row.machine)?.local ?? false

  return (
    <View style={styles.fill}>
      <HomeHeader title="Feed">
        <HeaderIconButton icon={Settings} label="Settings" onPress={props.onOpenSettings} />
      </HomeHeader>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.content, { paddingBottom: props.bottomPad }]}
        refreshControl={
          <RefreshControl
            refreshing={props.refreshing}
            onRefresh={props.onRefresh}
            tintColor={colors.textSecondary}
            colors={[colors.textSecondary]}
            progressBackgroundColor={colors.bgRaised}
          />
        }
      >
        {sections.map((section, index) => (
          <View key={section.kind}>
            <HomeSectionHeading
              title={section.title}
              count={section.total}
              first={index === 0}
              link={{ label: 'See all', onPress: props.onSeeAll }}
            />
            <ListGroup surface="page" separatorInset={LIST_LEADING_INSET}>
              {section.shown.map((session) => (
                <AgentRow key={`${session.serverId}:${session.machine}:${session.id}`} session={session} onOpen={props.onOpenSession} />
              ))}
            </ListGroup>
          </View>
        ))}
        <HomeSectionHeading title="Machines" count={rows.length} first={sections.length === 0} />
        <ListGroup surface="page" separatorInset={MACHINE_SEPARATOR_INSET}>
          {rows.map((row) => (
            <MachineRowItem key={row.key} row={row} local={isLocal(row)} onOpen={props.onOpenMachine} onMenu={props.onMachineMenu} />
          ))}
          <ListRow
            key="pair"
            title="Pair a server"
            accent
            leading={<Plus size={18} color={colors.accentBlue} strokeWidth={2.2} />}
            onPress={props.onPair}
          />
        </ListGroup>
        {rows.length === 0 ? <Text style={styles.hint}>Waiting for your servers.</Text> : null}
      </ScrollView>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  fill: { flex: 1 },
  content: { paddingHorizontal: spacing.lg },
  hint: { marginTop: spacing.md, fontSize: 13, color: colors.textMuted, textAlign: 'center' }
}))
