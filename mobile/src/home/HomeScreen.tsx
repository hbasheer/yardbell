import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { Gauge, LayoutList, SquareTerminal } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, BackHandler, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useNewSession } from '@/new-session/NewSessionProvider'
import { ServerMenus } from '@/machine/ServerMenus'
import { listServers, onServersChanged, type PairedServer } from '@/servers/store'
import type { Connection } from '@/state/liveSocket'
import type { StateView } from '@/state/types'
import { useServerState } from '@/state/useServerState'
import { feedSections, type MachineRow, type ServerSession, type ServerState } from '@/state/views'
import { Fab } from '@/ui/Fab'
import { TAB_BAR_HEIGHT, TabBar, type TabBarItem } from '@/ui/TabBar'
import { triggerMediumImpact } from '@/ui/haptics'
import { colors, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'
import { EmptyHero } from './EmptyHero'
import { FeedTab } from './FeedTab'
import { sessionHref } from './presentation'
import { SessionsTab } from './SessionsTab'
import { UsageTab } from './UsageTab'

type TabId = 'feed' | 'sessions' | 'usage'
type Live = { state: StateView | undefined; connection: Connection }

const FAB_CLEARANCE = 56 + spacing.lg

function ServerFeed({
  server,
  onChange,
  onReconnect
}: {
  server: PairedServer
  onChange: (id: string, live: Live) => void
  onReconnect: (id: string, reconnect: () => void) => void
}) {
  const { state, connection, reconnect } = useServerState(server)
  useEffect(() => {
    onChange(server.id, { state, connection })
  }, [server.id, state, connection, onChange])
  useEffect(() => {
    onReconnect(server.id, reconnect)
  }, [server.id, reconnect, onReconnect])
  return null
}

export function HomeScreen() {
  useColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const queryClient = useQueryClient()
  const newSession = useNewSession()
  const [servers, setServers] = useState<PairedServer[] | null>(null)
  const [live, setLive] = useState<Record<string, Live>>({})
  const reconnects = useRef<Record<string, () => void>>({})
  const [tab, setTab] = useState<TabId>('feed')
  const [visited, setVisited] = useState<Set<TabId>>(new Set(['feed']))
  const [refreshing, setRefreshing] = useState(false)
  const [menuFor, setMenuFor] = useState<MachineRow | null>(null)

  useEffect(() => {
    listServers()
      .then(setServers)
      .catch((error) => {
        console.error('Could not read saved servers', error)
        setServers([])
      })
    return onServersChanged(setServers)
  }, [])

  useEffect(() => {
    if (tab === 'feed') return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setTab('feed')
      return true
    })
    return () => subscription.remove()
  }, [tab])

  const report = useCallback((id: string, next: Live) => setLive((prev) => ({ ...prev, [id]: next })), [])
  const registerReconnect = useCallback((id: string, fn: () => void) => {
    reconnects.current[id] = fn
  }, [])

  const entries: ServerState[] = useMemo(
    () =>
      (servers ?? []).map((server) => ({
        server,
        state: live[server.id]?.state,
        connection: live[server.id]?.connection ?? 'reconnecting'
      })),
    [servers, live]
  )

  const needsYou = useMemo(() => feedSections(entries).find((s) => s.kind === 'needs-you')?.total ?? 0, [entries])
  const anyConnected = entries.some((e) => e.connection === 'connected')

  const select = (id: string) => {
    const next = id as TabId
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)))
    setTab(next)
  }

  const openSession = (session: ServerSession) => {
    const href = sessionHref(session)
    if (href) router.push(href as never)
  }
  const openMachine = (row: MachineRow) =>
    router.push(`/machine/${encodeURIComponent(row.serverId)}/${encodeURIComponent(row.machine)}` as never)
  const openSettings = () => router.push('/settings' as never)
  const pair = () => router.push('/pair')

  const reconnectAll = () => {
    for (const reconnect of Object.values(reconnects.current)) reconnect()
  }

  const refresh = async () => {
    setRefreshing(true)
    for (const entry of entries) if (entry.connection !== 'connected') reconnects.current[entry.server.id]?.()
    await queryClient.refetchQueries({ queryKey: ['state'] }).catch(() => {})
    setRefreshing(false)
  }

  const serverOf = (row: MachineRow | null) => servers?.find((s) => s.id === row?.serverId)

  const menuServer = serverOf(menuFor)

  const tabs: TabBarItem[] = [
    { id: 'feed', label: 'Feed', icon: LayoutList },
    { id: 'sessions', label: 'Sessions', icon: SquareTerminal, badge: needsYou },
    { id: 'usage', label: 'Usage', icon: Gauge }
  ]

  if (servers === null) {
    return (
      <View style={[styles.screen, styles.centred, { paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    )
  }

  if (servers.length === 0) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <EmptyHero onScan={pair} bottomInset={insets.bottom} />
      </View>
    )
  }

  const bottomPad = spacing.xl + FAB_CLEARANCE
  const tabBottom = TAB_BAR_HEIGHT + Math.max(insets.bottom, spacing.lg)

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {servers.map((server) => (
        <ServerFeed key={server.id} server={server} onChange={report} onReconnect={registerReconnect} />
      ))}
      <View style={[styles.pane, tab !== 'feed' && styles.hidden]}>
        <FeedTab
          servers={entries}
          bottomPad={bottomPad}
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          onOpenSettings={openSettings}
          onOpenSession={openSession}
          onOpenMachine={openMachine}
          onMachineMenu={(row) => {
            triggerMediumImpact()
            setMenuFor(row)
          }}
          onSeeAll={() => select('sessions')}
          onPair={pair}
        />
      </View>
      {visited.has('sessions') ? (
        <View style={[styles.pane, tab !== 'sessions' && styles.hidden]}>
          <SessionsTab
            servers={entries}
            bottomPad={spacing.xl}
            onOpenSettings={openSettings}
            onOpenSession={openSession}
            onReconnect={reconnectAll}
          />
        </View>
      ) : null}
      {visited.has('usage') ? (
        <View style={[styles.pane, tab !== 'usage' && styles.hidden]}>
          <UsageTab servers={entries} bottomPad={spacing.xl} onOpenSettings={openSettings} />
        </View>
      ) : null}
      <Fab
        visible={tab === 'feed'}
        disabled={!anyConnected}
        disabledHint="Connect a server to start a session."
        accessibilityLabel="New session"
        bottom={tabBottom + spacing.lg}
        onPress={() => newSession.open()}
      />
      <TabBar tabs={tabs} active={tab} bottomInset={insets.bottom} onSelect={select} />
      <ServerMenus
        server={menuServer}
        title={menuFor?.machine}
        visible={menuFor !== null}
        onClose={() => setMenuFor(null)}
        onReconnect={() => menuServer && reconnects.current[menuServer.id]?.()}
      />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  centred: { justifyContent: 'center' },
  pane: { flex: 1 },
  hidden: { display: 'none' }
}))
