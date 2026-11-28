import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router'
import { Activity, ChevronLeft, Eraser, ExternalLink, FileDiff, FolderTree, Info, MoreHorizontal, Search, Square, Terminal, Type } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, Keyboard, KeyboardAvoidingView, Linking, Pressable, StyleSheet, Text, View, type HostInstance } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { ApiClient } from '@/api/client'
import * as Clipboard from 'expo-clipboard'
import { getRunsOn } from '@/dispatch/api'
import { MicButton } from '@/dispatch/voice/MicButton'
import { InsightsSheet } from '@/dispatch/insights/InsightsSheet'
import { suggestHref } from '@/dispatch/insights/model'
import { useReviewBranch } from '@/dispatch/useReviewBranch'
import { machineHref } from '@/home/presentation'
import { placeHref } from '@/places/model'
import { useNewSession } from '@/new-session/NewSessionProvider'
import { listServers, onServersChanged, type PairedServer } from '@/servers/store'
import { stateKey, useServerState } from '@/state/useServerState'
import type { StateView as ServerStateView } from '@/state/types'
import { statusOf, type ServerState } from '@/state/views'
import { AddCustomKeySheet } from '@/terminal/AddCustomKeySheet'
import { AttachStatus } from '@/terminal/AttachStatus'
import { addCustomKey, removeCustomKey, useCustomKeys, type CustomKey } from '@/terminal/customKeys'
import { defBytes, type KeyDef } from '@/terminal/keyDefs'
import { KeyRow } from '@/terminal/KeyRow'
import { hasMods, keyBytes, withMods } from '@/terminal/keys'
import { consumeLatches, modsOf, NO_LATCHES, tapLatch, type LatchName } from '@/terminal/latches'
import { endsLine } from '@/terminal/liveInput'
import { LiveInput } from '@/terminal/LiveInput'
import { toBase64 } from '@/terminal/protocol'
import type { AgentInfo } from '@/terminal/replies'
import { SmartKeys } from '@/terminal/SmartKeys'
import { useTerminalPrefs } from '@/terminal/terminalPrefs'
import { useAttach } from '@/terminal/useAttach'
import { terminalHtml } from '@/terminal/terminalHtml'
import { isListedLive, shouldReconnectOnForeground } from '@/terminal/reconnect'
import { useTerminalSocket } from '@/terminal/useTerminalSocket'
import { ActionSheet, type ActionSheetAction } from '@/ui/ActionSheet'
import { ConfirmModal } from '@/ui/ConfirmModal'
import { bottomBarPadding } from '@/ui/bottomInset'
import { NAV_BAR_HEIGHT, NavBar } from '@/ui/NavBar'
import { NavBarButton } from '@/ui/NavBarButton'
import { OfflineState, StateButton, StateView } from '@/ui/StateView'
import { StatusDot } from '@/ui/StatusDot'
import { TabStrip } from '@/ui/TabStrip'
import { PullDownMenu } from '@/ui/PullDownMenu'
import { useKeyboardHeight } from '@/ui/useKeyboardHeight'
import { colors, pressedStyle, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'
import {
  CLEAR_TERMINAL,
  TEXT_SIZES,
  dotState,
  othersNeedYou,
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
  | { type: 'fontSize'; size: number }
  | { type: 'ready' }

const ESC = '\x1b'
const PAGE_URL = 'about:blank'

const param = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? ''

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
  useColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardHeight()
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
  const { fontSize, fontFamily, setFontSize } = useTerminalPrefs()
  const prefsRef = useRef({ fontSize, fontFamily })
  prefsRef.current = { fontSize, fontFamily }
  const [latches, setLatches] = useState(NO_LATCHES)
  const latchesRef = useRef(latches)
  latchesRef.current = latches
  const customKeys = useCustomKeys()

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
  const queryClient = useQueryClient()
  const canRetryAfterExit = useCallback(async () => {
    await queryClient.refetchQueries({ queryKey: stateKey(serverId) }).catch(() => {})
    return isListedLive(queryClient.getQueryData<ServerStateView>(stateKey(serverId)), machine, name)
  }, [queryClient, serverId, machine, name])
  const term = useTerminalSocket(server, machine, name, onOutput, onExit, onReopen, canRetryAfterExit)

  const { reconnect: reconnectTerminal } = term
  const reconnectNow = useCallback(() => {
    setEnded(null)
    live.reconnect()
    reconnectTerminal()
  }, [live.reconnect, reconnectTerminal])

  const downStatus = useRef(term.status)
  downStatus.current = term.status
  const liveState = useRef(live.state)
  liveState.current = live.state
  const target = useRef({ machine, name })
  target.current = { machine, name }
  const wasActive = useRef(appActive)
  useEffect(() => {
    const returned = appActive && !wasActive.current
    wasActive.current = appActive
    if (!returned) return
    if (shouldReconnectOnForeground(downStatus.current, liveState.current, target.current.machine, target.current.name)) {
      setEnded(null)
      reconnectTerminal()
    }
  }, [appActive, reconnectTerminal])

  const { view } = term
  useEffect(() => {
    view(visible)
  }, [view, visible])

  useEffect(() => {
    toPage({ type: 'fontSize', size: fontSize })
  }, [fontSize, toPage])

  useEffect(() => {
    toPage({ type: 'font', family: fontFamily })
  }, [fontFamily, toPage])

  const [liveReset, setLiveReset] = useState(0)
  const clearLive = useCallback(() => setLiveReset((n) => n + 1), [])
  const send = useCallback(
    (bytes: string) => {
      term.send(bytes)
      clearLive()
    },
    [term.send, clearLive]
  )
  const sendLive = useCallback(
    (bytes: string) => {
      term.send(bytes)
      if (endsLine(bytes)) clearLive()
    },
    [term.send, clearLive]
  )
  useEffect(clearLive, [name, clearLive])

  const takeMods = useCallback(() => {
    const mods = modsOf(latchesRef.current)
    if (hasMods(mods)) {
      const next = consumeLatches(latchesRef.current)
      latchesRef.current = next
      setLatches(next)
    }
    return mods
  }, [])

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
      web.current?.postMessage(JSON.stringify({ type: 'font', family: prefsRef.current.fontFamily }))
      web.current?.postMessage(JSON.stringify({ type: 'fontSize', size: prefsRef.current.fontSize }))
      for (const text of backlog.current.splice(0)) web.current?.postMessage(text)
    } else if (message.type === 'input') {
      const mods = modsOf(latchesRef.current)
      const changed = hasMods(mods) ? withMods(message.d, mods) : null
      if (changed !== null) takeMods()
      send(changed ?? message.d)
    } else if (message.type === 'resize') {
      term.resize(message.rows, message.cols)
    } else if (message.type === 'scroll') {
      term.scroll(message.lines)
    } else if (message.type === 'fontSize') {
      setFontSize(message.size)
    }
  }

  const onKey = (def: KeyDef) => send(defBytes(def, takeMods()))
  const onLatch = (name: LatchName, doubleTap: boolean) => setLatches((current) => tapLatch(current, name, doubleTap))
  const onTypedChar = (char: string) => {
    const mods = modsOf(latchesRef.current)
    if (!hasMods(mods)) return null
    takeMods()
    return keyBytes(char, mods)
  }
  const dismissKeyboard = () => {
    Keyboard.dismiss()
    toPage({ type: 'blur' })
  }
  const [addKeyOpen, setAddKeyOpen] = useState(false)
  const [deleting, setDeleting] = useState<CustomKey | null>(null)

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
  const [insightsOpen, setInsightsOpen] = useState(false)
  const moreRef = useRef<HostInstance>(null)
  const stopSession = useStopSession(server, () =>
    router.canGoBack() ? router.back() : router.replace(machineHref({ serverId, machine }) as never)
  )

  const report = (title: string) => (error: unknown) =>
    setFailure({ title, message: error instanceof Error ? error.message : String(error) })
  const review = useReviewBranch(server, setFailure)

  const runsOn = useQuery({ queryKey: ['dispatch', 'runs-on', server.id], queryFn: () => getRunsOn(server), staleTime: 30_000 })

  const attach = useAttach(
    server,
    machine,
    name,
    useCallback(
      (text: string) => {
        term.send(text)
        clearLive()
      },
      [term.send, clearLive]
    )
  )
  const paste = () => {
    Clipboard.getStringAsync()
      .then((text) => {
        if (!text) return
        toPage({ type: 'paste', text })
        clearLive()
      })
      .catch(report('Could not read the clipboard'))
  }

  const pasteText = (text: string) => {
    toPage({ type: 'paste', text: text.trim() })
    clearLive()
  }

  const answer = (keys: string) => {
    clearLive()
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
  const sessionRoot = [session?.path, session?.cwd].find((p) => p?.startsWith('/'))
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
      {
        label: 'Changes',
        icon: FileDiff,
        disabled: !sessionRoot,
        hint: sessionRoot ? undefined : 'No folder known',
        onPress: () => sessionRoot && router.push(placeHref('changes', serverId, machine, sessionRoot) as never)
      },
      {
        label: 'Files',
        icon: FolderTree,
        disabled: !sessionRoot,
        hint: sessionRoot ? undefined : 'No folder known',
        onPress: () => sessionRoot && router.push(placeHref('files', serverId, machine, sessionRoot) as never)
      },
      { label: 'Insights', icon: Activity, onPress: () => setInsightsOpen(true) },
      { label: 'Review branch', icon: Search, disabled: review.busy, loading: review.busy, onPress: () => void review.start(machine, name) },
      { label: 'Text size', icon: Type, status: `${fontSize}`, closeBeforePress: true, onPress: () => setSizeOpen(true) }
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
    checked: size === fontSize,
    onPress: () => setFontSize(size)
  }))

  const banner = !terminalShown
    ? null
    : (ended ?? (term.status === 'reconnecting' ? 'Reconnecting...' : term.status === 'connecting' ? 'Connecting...' : null))
  const newDisabled = body.kind === 'offline' || live.connection === 'unreachable'
  const newTab = () => newSession.open({ serverId, machine })

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, backgroundColor: colors.terminalBg }}
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
          {ended && <StateButton label="Reconnect" onPress={reconnectNow} inRow />}
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
          style={{ flex: 1, backgroundColor: colors.terminalBg }}
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
                action={{ label: 'Reconnect', onPress: reconnectNow }}
                secondaryAction={{ label: 'Back', onPress: () => router.back() }}
              />
            )}
          </View>
        )}
      </View>
      <View style={[styles.dock, { paddingBottom: keyboard.height > 0 ? 0 : bottomBarPadding(insets.bottom) }]}>
        <KeyRow
          latches={latches}
          keyboardUp={keyboard.height > 0}
          smart={
            terminalShown ? (
              <SmartKeys info={ended ? undefined : agent.data} onKeys={answer} onCancel={() => send(ESC)} />
            ) : undefined
          }
          customKeys={customKeys}
          disabled={!terminalShown}
          onDismissKeyboard={dismissKeyboard}
          onPaste={paste}
          onLatch={onLatch}
          onKey={onKey}
          onCustom={(custom) => send(custom.bytes)}
          onDeleteCustom={setDeleting}
          onAddCustom={() => setAddKeyOpen(true)}
        />
        <AttachStatus state={attach.state} onDismiss={attach.dismiss} />
        <LiveInput
          disabled={!terminalShown}
          onBytes={sendLive}
          onTypedChar={onTypedChar}
          resetSignal={liveReset}
          onAttach={attach.pickPhoto}
          onAttachFile={attach.pickFile}
          attachBusy={attach.state.kind === 'uploading'}
          renderMic={(onPhase) => (
            <MicButton
              server={server}
              runsOn={runsOn.data}
              onText={pasteText}
              onProblem={(message) => setFailure({ title: 'Dictation', message })}
              onPhase={onPhase}
            />
          )}
        />
      </View>
      <AddCustomKeySheet
        visible={addKeyOpen}
        onAdd={addCustomKey}
        onClose={() => setAddKeyOpen(false)}
      />
      <ConfirmModal
        visible={deleting !== null}
        title={`Delete ${deleting?.label ?? 'key'}?`}
        message="The key is removed from the key row on every session."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (deleting) removeCustomKey(deleting.id).catch(report('Could not delete the key'))
        }}
        onCancel={() => setDeleting(null)}
      />
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
      <InsightsSheet
        server={server}
        target={insightsOpen ? { machine, name } : null}
        onClose={() => setInsightsOpen(false)}
        onSuggest={(suggestion) => router.push(suggestHref(serverId, suggestion) as never)}
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
    </KeyboardAvoidingView>
  )
}

const styles = themedStyleSheet(() => ({
  blank: { flex: 1, backgroundColor: colors.bgBase },
  dock: { backgroundColor: colors.bgPanel },
  chrome: { backgroundColor: colors.bgPanel },
  navBar: { backgroundColor: colors.bgPanel, borderBottomWidth: 0 },
  titleBlock: { alignItems: 'center', maxWidth: '100%', minHeight: NAV_BAR_HEIGHT - spacing.sm, justifyContent: 'center' },
  title: { color: colors.textPrimary, fontSize: 16, fontWeight: '600', maxWidth: '100%' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%' },
  statusText: { color: colors.textSecondary, fontSize: 12, flexShrink: 1 },
  banner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: 6, backgroundColor: colors.bgRaised },
  bannerText: { flexShrink: 1, color: colors.textPrimary, fontSize: 13 },
  gone: { backgroundColor: colors.bgBase }
}))
