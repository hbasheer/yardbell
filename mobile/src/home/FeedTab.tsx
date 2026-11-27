import { Inbox, Plus, Settings } from 'lucide-react-native'
import { RefreshControl, ScrollView, Text, View } from 'react-native'
import { ChatRow } from '@/dispatch/ChatRow'
import type { ConversationRow } from '@/dispatch/listModel'
import { inboxRows, inboxRowSubtitle } from '@/inbox/model'
import { feedSections, machineRows, type MachineRow, type ServerSession, type ServerState } from '@/state/views'
import { LIST_LEADING_INSET, ListGroup } from '@/ui/ListGroup'
import { ListRow } from '@/ui/ListRow'
import { colors, fixedColors, radii, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'
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
  onOpenInbox: (serverId: string) => void
  dispatchRows: ConversationRow[]
  dispatchActive: number
  onOpenChat: (row: ConversationRow) => void
  onSeeDispatch: () => void
  onSeeAll: () => void
  onPair: () => void
}

export function FeedTab(props: Props) {
  useColorScheme()
  const sections = feedSections(props.servers)
  const rows = machineRows(props.servers)
  const inbox = inboxRows(props.servers)
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
        {inbox.length > 0 ? (
          <View style={styles.inbox}>
            <ListGroup surface="page" separatorInset={LIST_LEADING_INSET}>
              {inbox.map((row) => (
                <ListRow
                  key={row.serverId}
                  title="Inbox"
                  subtitle={inboxRowSubtitle(row, props.servers.length)}
                  subtitleLines={1}
                  leading={<Inbox size={18} color={colors.textSecondary} strokeWidth={2} />}
                  accessory={
                    <View style={styles.count}>
                      <Text style={styles.countText}>{row.waiting > 99 ? '99+' : row.waiting}</Text>
                    </View>
                  }
                  navigates
                  accessibilityLabel={`Inbox, ${inboxRowSubtitle(row, props.servers.length)}`}
                  onPress={() => props.onOpenInbox(row.serverId)}
                />
              ))}
            </ListGroup>
          </View>
        ) : null}
        {props.dispatchRows.length > 0 ? (
          <View>
            <HomeSectionHeading
              title="Dispatch"
              count={props.dispatchActive}
              first={inbox.length === 0}
              link={{ label: 'See all', onPress: props.onSeeDispatch }}
            />
            <ListGroup surface="page" separatorInset={LIST_LEADING_INSET}>
              {props.dispatchRows.map((row) => (
                <ChatRow
                  key={`${row.serverId}:${row.id}`}
                  row={row}
                  machine={props.servers.length > 1 ? row.machine : undefined}
                  onPress={() => props.onOpenChat(row)}
                />
              ))}
            </ListGroup>
          </View>
        ) : null}
        {sections.map((section, index) => (
          <View key={section.kind}>
            <HomeSectionHeading
              title={section.title}
              count={section.total}
              first={index === 0 && inbox.length === 0 && props.dispatchRows.length === 0}
              link={{ label: 'See all', onPress: props.onSeeAll }}
            />
            <ListGroup surface="page" separatorInset={LIST_LEADING_INSET}>
              {section.shown.map((session) => (
                <AgentRow key={`${session.serverId}:${session.machine}:${session.id}`} session={session} onOpen={props.onOpenSession} />
              ))}
            </ListGroup>
          </View>
        ))}
        <HomeSectionHeading title="Machines" count={rows.length} first={sections.length === 0 && inbox.length === 0 && props.dispatchRows.length === 0} />
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
  inbox: { marginTop: spacing.xs },
  count: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 7,
    borderRadius: radii.pill,
    backgroundColor: colors.statusAmber,
    alignItems: 'center',
    justifyContent: 'center'
  },
  countText: { fontSize: 12, fontWeight: '700', color: fixedColors.black, fontVariant: ['tabular-nums'] },
  hint: { marginTop: spacing.md, fontSize: 13, color: colors.textMuted, textAlign: 'center' }
}))
