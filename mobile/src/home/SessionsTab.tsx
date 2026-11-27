import { Search, Settings, SlidersHorizontal } from 'lucide-react-native'
import { useRef, useState } from 'react'
import { ScrollView, View, type HostInstance } from 'react-native'
import { sessionsTab, type ServerSession, type ServerState, type SessionGroupBy } from '@/state/views'
import type { ActionSheetAction } from '@/ui/ActionSheet'
import { LIST_LEADING_INSET, ListGroup } from '@/ui/ListGroup'
import { PullDownMenu } from '@/ui/PullDownMenu'
import { SearchField } from '@/ui/SearchField'
import { NoMatchState, OfflineState, StateView } from '@/ui/StateView'
import { SquareTerminal } from 'lucide-react-native'
import { spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'
import { AgentRow } from './AgentRow'
import { HeaderIconButton, HomeHeader } from './HomeHeader'
import { HomeSectionHeading } from './HomeSectionHeading'

const GROUPS: { id: SessionGroupBy; label: string }[] = [
  { id: 'status', label: 'Status' },
  { id: 'machine', label: 'Machine' },
  { id: 'project', label: 'Project' },
  { id: 'agent', label: 'Agent' }
]

type Props = {
  servers: ServerState[]
  bottomPad: number
  onOpenSettings: () => void
  onOpenSession: (session: ServerSession) => void
  onReconnect: () => void
}

export function SessionsTab(props: Props) {
  useColorScheme()
  const [groupBy, setGroupBy] = useState<SessionGroupBy>('status')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const optionsRef = useRef<HostInstance>(null)

  const sections = sessionsTab(props.servers, groupBy, query)
  const loaded = props.servers.some((s) => s.state)
  const unreachable = props.servers.length > 0 && props.servers.every((s) => s.connection === 'unreachable' && !s.state)
  const total = props.servers.reduce((n, s) => n + (s.state?.sessions.length ?? 0), 0)

  const toggleSearch = () => {
    if (searching) setQuery('')
    setSearching(!searching)
  }

  const menu: ActionSheetAction[] = GROUPS.map((group) => ({
    id: group.id,
    label: `Group by ${group.label.toLowerCase()}`,
    checked: groupBy === group.id,
    onPress: () => setGroupBy(group.id)
  }))

  let body
  if (unreachable) body = <OfflineState message="None of your servers can be reached." onReconnect={props.onReconnect} />
  else if (!loaded) body = <StateView loading title="Loading sessions" />
  else if (total === 0)
    body = <StateView icon={SquareTerminal} title="No sessions running" message="Start one with the + button on Feed." />
  else if (sections.length === 0)
    body = <NoMatchState message={`No session matches "${query.trim()}".`} onClear={() => setQuery('')} />
  else
    body = (
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.content, { paddingBottom: props.bottomPad }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {sections.map((section, index) => (
          <View key={section.key}>
            <HomeSectionHeading title={section.title} count={section.sessions.length} first={index === 0} />
            <ListGroup surface="page" separatorInset={LIST_LEADING_INSET}>
              {section.sessions.map((session) => (
                <AgentRow key={`${session.serverId}:${session.machine}:${session.id}`} session={session} onOpen={props.onOpenSession} />
              ))}
            </ListGroup>
          </View>
        ))}
      </ScrollView>
    )

  return (
    <View style={styles.fill}>
      <HomeHeader title="Sessions">
        <HeaderIconButton icon={Search} label="Search sessions" onPress={toggleSearch} active={searching} />
        <HeaderIconButton
          icon={SlidersHorizontal}
          label="Group sessions"
          onPress={() => setMenuOpen(true)}
          active={menuOpen}
          anchorRef={optionsRef}
        />
        <HeaderIconButton icon={Settings} label="Settings" onPress={props.onOpenSettings} />
      </HomeHeader>
      {searching ? (
        <View style={styles.search}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder="Search sessions"
            autoFocus
            onClear={() => setQuery('')}
          />
        </View>
      ) : null}
      {body}
      <PullDownMenu visible={menuOpen} anchorRef={optionsRef} groups={[menu]} onClose={() => setMenuOpen(false)} />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  fill: { flex: 1 },
  content: { paddingHorizontal: spacing.lg },
  search: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }
}))
