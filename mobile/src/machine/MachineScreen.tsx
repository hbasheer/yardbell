import * as Clipboard from 'expo-clipboard'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  ChevronLeft,
  ExternalLink,
  FolderOpen,
  FolderTree,
  GitBranch,
  MoreHorizontal,
  Plus,
  SlidersHorizontal,
  Square,
  Terminal,
  WifiOff
} from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Linking, Pressable, SectionList, StyleSheet, Text, View, type HostInstance } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { sessionHref } from '@/home/presentation'
import { useNewSession } from '@/new-session/NewSessionProvider'
import { useStopSession } from '@/session/useStopSession'
import { listServers, onServersChanged, type PairedServer } from '@/servers/store'
import { useServerState } from '@/state/useServerState'
import { machineSections, statusOf, type ServerSession, type ServerState } from '@/state/views'
import { ActionSheet, type ActionSheetAction } from '@/ui/ActionSheet'
import { BottomSearchBar } from '@/ui/BottomSearchBar'
import { ConfirmModal } from '@/ui/ConfirmModal'
import { NavBar } from '@/ui/NavBar'
import { NavBarButton } from '@/ui/NavBarButton'
import { PageTitle, useCollapsingTitle } from '@/ui/PageTitle'
import { SectionHeader } from '@/ui/SectionHeader'
import { NoMatchState, OfflineState, StateView } from '@/ui/StateView'
import { StatusDot, type ConnectionState } from '@/ui/StatusDot'
import { triggerMediumImpact } from '@/ui/haptics'
import { colors, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'
import {
  DEFAULT_OPTIONS,
  activeOptionCount,
  collapseKey,
  parseCollapsed,
  parseOptions,
  toggleCollapsed,
  type MachineOptions
} from './options'
import { OptionsSheet } from './OptionsSheet'
import { machineBody, machineStatus, stateLine } from './presentation'
import { ServerMenus } from './ServerMenus'
import { usePersisted } from './usePersisted'
import { ROW_SEPARATOR_INSET, WorkspaceRow, sessionTitle } from './WorkspaceRow'

const param = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? ''

const DOT_STATE: Record<string, ConnectionState> = {
  up: 'connected',
  loading: 'connecting',
  reconnecting: 'reconnecting',
  unreachable: 'unreachable',
  down: 'disconnected'
}

const serializeOptions = (value: MachineOptions) => JSON.stringify(value)
const serializeCollapsed = (value: ReadonlySet<string>) => JSON.stringify([...value])

type Row = { session: ServerSession; last: boolean }
type Section = { key: string; title: string; count: number; collapsed: boolean; data: Row[] }

export function MachineScreen() {
  const params = useLocalSearchParams<{ server: string; machine: string }>()
  const serverId = param(params.server)
  const machine = param(params.machine)
  const [servers, setServers] = useState<PairedServer[] | null>(null)

  useEffect(() => {
    listServers()
      .then(setServers)
      .catch((error) => {
        console.error('Could not read saved servers', error)
        setServers([])
      })
    return onServersChanged(setServers)
  }, [])

  const server = servers?.find((s) => s.id === serverId)
  const router = useRouter()
  useEffect(() => {
    if (servers !== null && !server) router.replace('/')
  }, [servers, server, router])

  if (!server) return <View style={styles.screen} />
  return <Machine server={server} machine={machine} multipleServers={(servers?.length ?? 0) > 1} />
}

function Machine({ server, machine, multipleServers }: { server: PairedServer; machine: string; multipleServers: boolean }) {
  useColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const newSession = useNewSession()
  const live = useServerState(server)
  const entry: ServerState = useMemo(
    () => ({ server, state: live.state, connection: live.connection }),
    [server, live.state, live.connection]
  )

  const [options, setOptions] = usePersisted('yardbell:machine-options', DEFAULT_OPTIONS, parseOptions, serializeOptions)
  const [collapsed, setCollapsed] = usePersisted<ReadonlySet<string>>(
    'yardbell:machine-collapsed',
    useMemo(() => new Set<string>(), []),
    parseCollapsed,
    serializeCollapsed
  )
  const [query, setQuery] = useState('')
  const [covered, setCovered] = useState(80)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [rowMenu, setRowMenu] = useState<ServerSession | null>(null)
  const stopSession = useStopSession(server)
  const [failure, setFailure] = useState<{ title: string; message: string } | null>(null)
  const moreRef = useRef<HostInstance>(null)
  const listRef = useRef<SectionList<Row, Section>>(null)

  const collapsing = useCollapsingTitle(
    useCallback((y: number) => {
      ;(listRef.current as unknown as { getScrollResponder(): { scrollTo(o: { y: number }): void } | null } | null)
        ?.getScrollResponder()
        ?.scrollTo({ y })
    }, [])
  )

  const status = machineStatus(entry, machine)
  const sections = useMemo(() => machineSections(entry, machine, options.groupBy, query, options.showStopped), [
    entry,
    machine,
    options,
    query
  ])
  const visibleSessions = sections.reduce((n, s) => n + s.sessions.length, 0)
  const body = machineBody(entry, machine, query, visibleSessions)

  const listSections: Section[] =
    body === 'list'
      ? sections.map((section) => {
          const key = collapseKey(server.id, machine, options.groupBy, section.key)
          const isCollapsed = collapsed.has(key)
          return {
            key,
            title: section.title,
            count: section.sessions.length,
            collapsed: isCollapsed,
            data: isCollapsed ? [] : section.sessions.map((session, i) => ({ session, last: i === section.sessions.length - 1 }))
          }
        })
      : []

  const openSession = (session: ServerSession) => {
    const href = sessionHref(session)
    if (href && session.attachable) router.push(href as never)
  }

  const reconnect = () => live.reconnect()
  const refreshing = live.connection === 'reconnecting' && live.state !== undefined
  const outage = live.state !== undefined && (live.connection !== 'connected' || status.status === 'down')

  const rowActions = (session: ServerSession): ActionSheetAction[] => {
    const openable = session.attachable && Boolean(session.tmux)
    const actions: ActionSheetAction[] = [
      {
        label: 'Open',
        icon: Terminal,
        disabled: !openable,
        hint: openable ? undefined : 'Not attachable',
        onPress: () => openSession(session)
      }
    ]
    if (session.pull) {
      const url = session.pull.url
      actions.push({
        label: 'Open PR',
        icon: ExternalLink,
        status: `#${session.pull.number}`,
        onPress: () => {
          Linking.openURL(url).catch((error) =>
            setFailure({ title: 'Could not open the pull request', message: error instanceof Error ? error.message : String(error) })
          )
        }
      })
    }
    const branch = session.branch && session.branch !== '-' ? session.branch : null
    const path = session.path ?? session.cwd
    if (branch) {
      actions.push({
        label: 'Copy branch',
        icon: GitBranch,
        onPress: () => {
          Clipboard.setStringAsync(branch).catch((error) => console.error('Could not copy the branch', error))
        }
      })
    }
    if (path) {
      actions.push({
        label: 'Copy path',
        icon: FolderOpen,
        onPress: () => {
          Clipboard.setStringAsync(path).catch((error) => console.error('Could not copy the path', error))
        }
      })
    }
    if (statusOf(session) !== 'stopped' && session.tmux) {
      actions.push({
        label: 'Stop session',
        icon: Square,
        destructive: true,
        closeBeforePress: true,
        onPress: () => stopSession.ask(session)
      })
    }
    return actions
  }

  const serverLabel = multipleServers && server.machine !== machine ? server.machine : null
  const subtitle = (
    <>
      <StatusDot state={DOT_STATE[status.status]} />
      <Text style={styles.stateLine} numberOfLines={1}>
        {stateLine(status, serverLabel)}
      </Text>
      {live.connection !== 'connected' || status.status === 'down' ? (
        <Pressable onPress={reconnect} hitSlop={8} accessibilityRole="button" accessibilityLabel="Reconnect">
          <Text style={styles.reconnect}>Reconnect</Text>
        </Pressable>
      ) : null}
    </>
  )

  const header = (
    <View>
      <PageTitle title={machine} subtitle={subtitle} onLayout={collapsing.onTitleLayout} />
      {outage && body === 'list' ? (
        <View style={styles.banner}>
          <WifiOff size={14} color={colors.statusAmber} strokeWidth={2} />
          <Text style={styles.bannerText} numberOfLines={2}>
            {status.status === 'down' ? status.reason : `${status.reason ?? 'Not connected'}. Showing the last known sessions.`}
          </Text>
        </View>
      ) : null}
    </View>
  )

  const clear = () => setQuery('')
  let empty = null
  if (body === 'loading') empty = <StateView loading title="Loading sessions" />
  else if (body === 'unreachable')
    empty = <OfflineState machineName={machine} message={status.reason ?? undefined} onReconnect={reconnect} />
  else if (body === 'down')
    empty = <OfflineState machineName={machine} message={status.reason ?? undefined} onReconnect={reconnect} />
  else if (body === 'empty')
    empty = (
      <StateView
        icon={FolderTree}
        title="No sessions"
        message={options.showStopped ? 'Start one with the + button.' : 'Nothing is running. Stopped sessions are hidden.'}
      />
    )
  else if (body === 'no-match') empty = <NoMatchState message={`No session matches "${query.trim()}".`} onClear={clear} />

  const newSessionDisabled = status.status !== 'up'

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <NavBar
        leading={<NavBarButton icon={ChevronLeft} accessibilityLabel="Back" onPress={() => router.back()} />}
        title={machine}
        titleOpacity={collapsing.barTitleOpacity}
        dividerOpacity={collapsing.barDividerOpacity}
        refreshing={refreshing}
        trailing={
          <View ref={moreRef} collapsable={false}>
            <NavBarButton
              icon={MoreHorizontal}
              accessibilityLabel="More"
              active={menuOpen}
              onPress={() => setMenuOpen(true)}
            />
          </View>
        }
      />
      <Animated.SectionList<Row, Section>
        ref={listRef as never}
        sections={listSections}
        keyExtractor={(row: Row) => `${row.session.serverId}:${row.session.machine}:${row.session.id}`}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onScroll={collapsing.onScroll}
        scrollEventThrottle={16}
        {...collapsing.touchHandlers}
        ListHeaderComponent={header}
        ListEmptyComponent={empty ? <View style={styles.empty}>{empty}</View> : undefined}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: covered + spacing.sm }}
        renderSectionHeader={({ section }: { section: Section }) => (
          <SectionHeader
            title={section.title}
            trailing={String(section.count)}
            expanded={!section.collapsed}
            first={false}
            onToggle={() => setCollapsed((current) => toggleCollapsed(current, section.key))}
          />
        )}
        renderItem={({ item }: { item: Row }) => (
          <View>
            <WorkspaceRow
              session={item.session}
              onOpen={openSession}
              onMenu={(session) => {
                triggerMediumImpact()
                setRowMenu(session)
              }}
            />
            {item.last ? null : <View style={styles.separator} />}
          </View>
        )}
      />
      <BottomSearchBar
        value={query}
        onChangeText={setQuery}
        placeholder="Search"
        bottomInset={insets.bottom}
        onCoveredHeightChange={setCovered}
        leading={{
          icon: SlidersHorizontal,
          accessibilityLabel: 'Workspace options',
          badge: activeOptionCount(options),
          onPress: () => setOptionsOpen(true)
        }}
        primary={{
          icon: Plus,
          accessibilityLabel: 'New session',
          disabled: newSessionDisabled,
          onPress: () => newSession.open({ serverId: server.id, machine })
        }}
      />
      <OptionsSheet visible={optionsOpen} options={options} onChange={setOptions} onClose={() => setOptionsOpen(false)} />
      <ServerMenus
        server={server}
        visible={menuOpen}
        anchorRef={moreRef}
        onClose={() => setMenuOpen(false)}
        onReconnect={reconnect}
      />
      <ActionSheet
        visible={rowMenu !== null}
        title={rowMenu ? sessionTitle(rowMenu) : undefined}
        message={rowMenu?.branch && rowMenu.branch !== '-' ? rowMenu.branch : undefined}
        actions={rowMenu ? rowActions(rowMenu) : []}
        onClose={() => setRowMenu(null)}
      />
      {stopSession.modals}
      <ConfirmModal
        visible={failure !== null}
        title={failure?.title ?? ''}
        message={failure?.message}
        cancelLabel={null}
        confirmLabel="OK"
        onCancel={() => setFailure(null)}
      />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  stateLine: { flexShrink: 1, fontSize: 12, color: colors.textSecondary },
  reconnect: { fontSize: 12, fontWeight: '600', color: colors.textPrimary },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 12,
    backgroundColor: colors.bgRaised
  },
  bannerText: { flex: 1, fontSize: 12, color: colors.textSecondary },
  empty: { minHeight: 360, flex: 1 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: ROW_SEPARATOR_INSET, backgroundColor: colors.borderSubtle }
}))
