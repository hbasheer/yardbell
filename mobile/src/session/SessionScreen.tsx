import { useQuery } from '@tanstack/react-query'
import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft, Eraser, ExternalLink, Info, MoreHorizontal, Square, Terminal, Type } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, KeyboardAvoidingView, Linking, Pressable, StyleSheet, Text, View, type HostInstance } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { ApiClient } from '@/api/client'
import { usePersisted } from '@/machine/usePersisted'
import { useNewSession } from '@/new-session/NewSessionProvider'
import { listServers, onServersChanged, type PairedServer } from '@/servers/store'
import { useServerState } from '@/state/useServerState'
import { statusOf, type ServerState } from '@/state/views'
import { KeyBar } from '@/terminal/KeyBar'
import { keyBytes, withMods, type KeyName, type Mods } from '@/terminal/keys'
import { toBase64 } from '@/terminal/protocol'
import { QuickReplies } from '@/terminal/QuickReplies'
import type { AgentInfo } from '@/terminal/replies'
import { terminalHtml } from '@/terminal/terminalHtml'
import { useTerminalSocket } from '@/terminal/useTerminalSocket'
import { terminalColors } from '@/theme/colors'
import { ActionSheet, type ActionSheetAction } from '@/ui/ActionSheet'
import { ConfirmModal } from '@/ui/ConfirmModal'
import { NAV_BAR_HEIGHT, NavBar } from '@/ui/NavBar'
import { NavBarButton } from '@/ui/NavBarButton'
import { OfflineState, StateView } from '@/ui/StateView'
import { StatusDot } from '@/ui/StatusDot'
import { TabStrip } from '@/ui/TabStrip'
import { PullDownMenu } from '@/ui/PullDownMenu'
import { colors, pressedStyle, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'
import {
  CLEAR_TERMINAL,
  TEXT_SIZES,
  DEFAULT_TEXT_SIZE,
  dotState,
  othersNeedYou,
  parseTextSize,
  sessionBody,
  statusLine,
  stepTarget,
  tabSessions
} from './chrome'
import { DetailsSheet } from './DetailsSheet'
import { TabsSheet } from './TabsSheet'
import { useStopSession } from './useStopSession'

type FromPage =
  | { type: 'input'; d: string }
  | { type: 'resize'; rows: number; cols: number }
  | { type: 'scroll'; lines: number }
  | { type: 'ready' }

const NO_MODS: Mods = { ctrl: false, alt: false }
const ESC = '\x1b'
const PAGE_URL = 'about:blank'

const param = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? ''

const parseSize = (raw: string | null): number | null => (raw === null ? null : parseTextSize(raw))
const serializeSize = (size: number | null) => String(size ?? DEFAULT_TEXT_SIZE)

function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active')
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => setActive(status === 'active'))
    return () => subscription.remove()
  }, [])
  return active
}

export function SessionScreen() {
  const params = useLocalSearchParams<{ server: string; machine: string; name: string }>()
  const serverId = param(params.server)
  const router = useRouter()
  const insets = useSafeAreaInsets()
  useColorScheme()
  const [server, setServer] = useState<PairedServer | null | undefined>(undefined)

  useEffect(() => {
    listServers()
      .then((servers) => setServer(servers.find((s) => s.id === serverId) ?? null))
      .catch((error) => {
        console.error('Could not read saved servers', error)
        setServer(null)
      })
    return onServersChanged((servers) => setServer(servers.find((s) => s.id === serverId) ?? null))
  }, [serverId])

  if (server === undefined) return <View style={styles.blank} />
  if (server === null) {
    return (
      <View style={[styles.blank, { paddingTop: insets.top }]}>
        <StateView
          icon={Terminal}
          title="Server not paired"
          message="This server is no longer paired with the phone."
          action={{ label: 'Back', onPress: () => router.back() }}
        />
      </View>
    )
  }
  return <Session server={server} machine={param(params.machine)} name={param(params.name)} />
}

function Session({ server, machine, name }: { server: PairedServer; machine: string; name: string }) {
  const scheme = useColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const newSession = useNewSession()
  const serverId = server.id
  const sessionPath = `/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(name)}`

  const live = useServerState(server)
  const entry: ServerState = useMemo(
    () => ({ server, state: live.state, connection: live.connection }),
    [server, live.state, live.connection]
  )

  const focused = useIsFocused()
  const appActive = useAppActive()
  const visible = focused && appActive
  // WebView's type parameter defaults to undefined, which turns its props into never.
  const web = useRef<WebView<object>>(null)
  const ready = useRef(false)
  const backlog = useRef<string[]>([])
  const [ended, setEnded] = useState<string | null>(null)
  const [textSize, setTextSize] = usePersisted<number | null>('yardbell:terminal-text-size', null, parseSize, serializeSize)
  const textSizeRef = useRef(textSize)
  textSizeRef.current = textSize
  const [mods, setMods] = useState<Mods>(NO_MODS)

  const toPage = useCallback((message: object) => {
    const text = JSON.stringify(message)
    if (ready.current) web.current?.postMessage(text)
    else backlog.current.push(text)
  }, [])

  const onOutput = useCallback((bytes: Uint8Array) => toPage({ type: 'output', b64: toBase64(bytes) }), [toPage])
  const onExit = useCallback(
    (msg: string) => {
      setEnded(msg)
      toPage({ type: 'output', b64: toBase64(new TextEncoder().encode(`\r\n\x1b[33m[${msg}]\x1b[0m\r\n`)) })
    },
    [toPage]
  )
  const onReopen = useCallback(() => toPage({ type: 'reset' }), [toPage])
  const term = useTerminalSocket(server, machine, name, onOutput, onExit, onReopen)

  const { view } = term
  useEffect(() => {
    view(visible)
  }, [view, visible])

  useEffect(() => {
    if (ready.current) toPage({ type: 'theme', colors: terminalColors[scheme] })
  }, [scheme, toPage])

  useEffect(() => {
    if (textSize !== null) toPage({ type: 'fontSize', size: textSize })
  }, [textSize, toPage])

  const shownName = useRef(name)
  useEffect(() => {
    if (shownName.current === name) return
    shownName.current = name
    setEnded(null)
    toPage({ type: 'reset' })
  }, [name, toPage])

  const onPageMessage = (event: WebViewMessageEvent) => {
    let message: FromPage
    try {
      message = JSON.parse(event.nativeEvent.data) as FromPage
    } catch {
      return
    }
    if (message.type === 'ready') {
      ready.current = true
      web.current?.postMessage(JSON.stringify({ type: 'theme', colors: terminalColors[scheme] }))
      if (textSizeRef.current !== null) web.current?.postMessage(JSON.stringify({ type: 'fontSize', size: textSizeRef.current }))
      for (const text of backlog.current.splice(0)) web.current?.postMessage(text)
    } else if (message.type === 'input') {
      const changed = mods.ctrl || mods.alt ? withMods(message.d, mods) : null
      if (changed !== null) setMods(NO_MODS)
      term.send(changed ?? message.d)
    } else if (message.type === 'resize') {
      term.resize(message.rows, message.cols)
    } else if (message.type === 'scroll') {
      term.scroll(message.lines)
    }
  }

  const onKey = (key: KeyName) => {
    term.send(keyBytes(key, mods))
    setMods(NO_MODS)
  }


  const client = useMemo(() => new ApiClient(server), [server])
  const meta = { serverId }

  const agent = useQuery({
    queryKey: ['agent', serverId, machine, name],
    queryFn: () => client.get<AgentInfo>(`${sessionPath}/agent`),
    refetchInterval: 3000,
    enabled: visible && !ended,
    meta
  })

  const tabs = useMemo(() => tabSessions(entry, machine, name), [entry, machine, name])
  const session = tabs.index >= 0 ? tabs.sessions[tabs.index] : undefined
  const body = sessionBody(entry, machine, name, term.status)
  const terminalShown = body.kind === 'terminal'
  const folder = session?.folder || name
  const line = statusLine(session)

  const [failure, setFailure] = useState<{ title: string; message: string } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [tabsOpen, setTabsOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [sizeOpen, setSizeOpen] = useState(false)
  const moreRef = useRef<HostInstance>(null)
  const stopSession = useStopSession(server, () => router.back())

  const report = (title: string) => (error: unknown) =>
    setFailure({ title, message: error instanceof Error ? error.message : String(error) })

  const answer = (keys: string) => {
    client.post(`${sessionPath}/keys`, { keys }).catch(report('Could not send the reply'))
    setTimeout(() => client.post(`${sessionPath}/agent`).catch(() => {}), 400)
  }

  const switchTo = (target: { tmux: string | null }) => {
    if (!target.tmux || target.tmux === name) return
    router.setParams({ name: target.tmux })
  }
  const step = (direction: 'previous' | 'next') => {
    const target = stepTarget(tabs, direction)
    if (target) switchTo(target)
  }

  const stoppable = session !== undefined && statusOf(session) !== 'stopped' && Boolean(session.tmux)
  const stop: ActionSheetAction = {
    label: 'Stop session',
    icon: Square,
    destructive: true,
    closeBeforePress: true,
    disabled: !stoppable,
    onPress: () => session && stopSession.ask(session)
  }
  const pullUrl = session?.pull?.url
  const menuGroups: ActionSheetAction[][] = [
    [
      { label: 'Session details', icon: Info, disabled: !session, onPress: () => setDetailsOpen(true) },
      ...(pullUrl
        ? [
            {
              label: 'Open PR',
              icon: ExternalLink,
              status: `#${session?.pull?.number}`,
              onPress: () => {
                Linking.openURL(pullUrl).catch(report('Could not open the pull request'))
              }
            }
          ]
        : []),
      { label: 'Text size', icon: Type, status: `${textSize ?? DEFAULT_TEXT_SIZE}`, closeBeforePress: true, onPress: () => setSizeOpen(true) }
    ],
    [stop]
  ]
  const tabActions: ActionSheetAction[] = [
    { label: 'Clear terminal', icon: Eraser, disabled: !terminalShown, onPress: () => term.send(CLEAR_TERMINAL) },
    stop
  ]
  const sizeActions: ActionSheetAction[] = TEXT_SIZES.map((size) => ({
    id: String(size),
    icon: Type,
    label: `${size}`,
    checked: size === (textSize ?? DEFAULT_TEXT_SIZE),
    onPress: () => setTextSize(size)
  }))

  const banner = !terminalShown
    ? null
    : (ended ?? (term.status === 'reconnecting' ? 'Reconnecting...' : term.status === 'connecting' ? 'Connecting...' : null))
  const newDisabled = body.kind === 'offline' || live.connection === 'unreachable'
  const newTab = () => newSession.open({ serverId, machine })

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, backgroundColor: terminalColors[scheme].background }}
    >
      <View style={[styles.chrome, { paddingTop: insets.top }]}>
        <NavBar
          style={styles.navBar}
          leading={<NavBarButton icon={ChevronLeft} accessibilityLabel="Back" onPress={() => router.back()} />}
          center={
            <Pressable
              onPress={() => setDetailsOpen(true)}
              disabled={!session}
              accessibilityRole="button"
              accessibilityLabel={`${folder}, details`}
              accessibilityHint="Shows where this session lives"
              style={({ pressed }) => [styles.titleBlock, pressed && pressedStyle]}
            >
              <Text style={styles.title} numberOfLines={1}>
                {folder}
              </Text>
              <View style={styles.statusRow}>
                <StatusDot state={dotState(live.connection, term.status, body)} />
                <Text style={styles.statusText} numberOfLines={1}>
                  {line || machine}
                </Text>
              </View>
            </Pressable>
          }
          trailing={
            <View ref={moreRef} collapsable={false}>
              <NavBarButton icon={MoreHorizontal} accessibilityLabel="More" active={menuOpen} onPress={() => setMenuOpen(true)} />
            </View>
          }
        />
        <TabStrip
          title={folder}
          glyph={session ? { activity: session.activity, stopped: session.stopped } : { activity: 'idle', stopped: 'gone' }}
          mark={<Terminal size={14} color={colors.textSecondary} strokeWidth={2} />}
          count={Math.max(tabs.sessions.length, 1)}
          othersNeedYou={othersNeedYou(tabs.sessions, name)}
          hasPrevious={tabs.index > 0}
          hasNext={tabs.index >= 0 && tabs.index < tabs.sessions.length - 1}
          newDisabled={newDisabled}
          onStep={step}
          onOpenActions={() => setActionsOpen(true)}
          onOpenTabs={() => setTabsOpen(true)}
          onNew={newTab}
        />
      </View>
      {banner && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{banner}</Text>
        </View>
      )}
      <View style={{ flex: 1 }}>
        <WebView<object>
          ref={web}
          source={{ html: terminalHtml, baseUrl: PAGE_URL }}
          originWhitelist={[PAGE_URL]}
          onShouldStartLoadWithRequest={(request) => request.url === PAGE_URL}
          onMessage={onPageMessage}
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView
          bounces={false}
          overScrollMode="never"
          style={{ flex: 1, backgroundColor: terminalColors[scheme].background }}
        />
        {body.kind === 'terminal' ? null : (
          <View style={[StyleSheet.absoluteFill, styles.gone]}>
            {body.kind === 'offline' ? (
              <OfflineState machineName={machine} message={body.message} onReconnect={live.reconnect} />
            ) : (
              <StateView
                icon={Terminal}
                title={body.title}
                message={body.message}
                action={{ label: 'Back', onPress: () => router.back() }}
              />
            )}
          </View>
        )}
      </View>
      {terminalShown ? (
        <QuickReplies info={ended ? undefined : agent.data} onKeys={answer} onCancel={() => term.send(ESC)} />
      ) : null}
      <View style={{ paddingBottom: insets.bottom, backgroundColor: colors.bgPanel }}>
        <KeyBar mods={mods} onToggle={(mod) => setMods((m) => ({ ...m, [mod]: !m[mod] }))} onKey={onKey} />
      </View>
      <PullDownMenu visible={menuOpen} anchorRef={moreRef} groups={menuGroups} onClose={() => setMenuOpen(false)} />
      <DetailsSheet
        visible={detailsOpen}
        session={session}
        serverAddress={server.address}
        onOpenFailed={report('Could not open the pull request')}
        onClose={() => setDetailsOpen(false)}
      />
      <TabsSheet
        visible={tabsOpen}
        sessions={tabs.sessions}
        current={name}
        newDisabled={newDisabled}
        onSwitch={switchTo}
        onNew={() => {
          setTabsOpen(false)
          newTab()
        }}
        onClose={() => setTabsOpen(false)}
      />
      <ActionSheet
        visible={actionsOpen}
        title={folder}
        message={line || undefined}
        actions={tabActions}
        onClose={() => setActionsOpen(false)}
      />
      <ActionSheet visible={sizeOpen} title="Text size" actions={sizeActions} onClose={() => setSizeOpen(false)} />
      {stopSession.modals}
      <ConfirmModal
        visible={failure !== null}
        title={failure?.title ?? ''}
        message={failure?.message}
        cancelLabel={null}
        confirmLabel="OK"
        onCancel={() => setFailure(null)}
      />
    </KeyboardAvoidingView>
  )
}

const styles = themedStyleSheet(() => ({
  blank: { flex: 1, backgroundColor: colors.bgBase },
  chrome: { backgroundColor: colors.bgPanel },
  navBar: { backgroundColor: colors.bgPanel, borderBottomWidth: 0 },
  titleBlock: { alignItems: 'center', maxWidth: '100%', minHeight: NAV_BAR_HEIGHT - spacing.sm, justifyContent: 'center' },
  title: { color: colors.textPrimary, fontSize: 16, fontWeight: '600', maxWidth: '100%' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%' },
  statusText: { color: colors.textSecondary, fontSize: 12, flexShrink: 1 },
  banner: { paddingHorizontal: spacing.lg, paddingVertical: 6, backgroundColor: colors.bgRaised },
  bannerText: { color: colors.textPrimary, fontSize: 13 },
  gone: { backgroundColor: colors.bgBase }
}))
