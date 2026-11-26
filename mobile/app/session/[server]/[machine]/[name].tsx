import { skipToken, useQuery } from '@tanstack/react-query'
import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, AppState, KeyboardAvoidingView, Pressable, Text, useColorScheme, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { ApiClient } from '@/api/client'
import { listServers, type PairedServer } from '@/servers/store'
import { stateKey } from '@/state/useServerState'
import type { StateView } from '@/state/types'
import { KeyBar } from '@/terminal/KeyBar'
import { keyBytes, withMods, type KeyName, type Mods } from '@/terminal/keys'
import { toBase64 } from '@/terminal/protocol'
import { QuickReplies } from '@/terminal/QuickReplies'
import type { AgentInfo } from '@/terminal/replies'
import { terminalHtml } from '@/terminal/terminalHtml'
import { useTerminalSocket } from '@/terminal/useTerminalSocket'
import { terminalColors } from '@/theme/colors'
import { useTheme } from '@/theme/useTheme'

type FromPage =
  | { type: 'input'; d: string }
  | { type: 'resize'; rows: number; cols: number }
  | { type: 'scroll'; lines: number }
  | { type: 'ready' }

const NO_MODS: Mods = { ctrl: false, alt: false }
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

export default function SessionScreen() {
  const theme = useTheme()
  const scheme = useColorScheme() === 'light' ? 'light' : 'dark'
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ server: string; machine: string; name: string }>()
  const serverId = param(params.server)
  const machine = param(params.machine)
  const name = param(params.name)
  const sessionPath = `/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(name)}`

  const [server, setServer] = useState<PairedServer | null | undefined>(undefined)
  useEffect(() => {
    listServers()
      .then((servers) => setServer(servers.find((s) => s.id === serverId) ?? null))
      .catch((error) => {
        console.error('Could not read saved servers', error)
        setServer(null)
      })
  }, [serverId])

  const focused = useIsFocused()
  const appActive = useAppActive()
  const visible = focused && appActive
  // WebView's type parameter defaults to undefined, which turns its props into never.
  const web = useRef<WebView<object>>(null)
  const ready = useRef(false)
  const backlog = useRef<string[]>([])
  const [ended, setEnded] = useState<string | null>(null)
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
  const term = useTerminalSocket(server ?? null, machine, name, onOutput, onExit, onReopen)

  const { view } = term
  useEffect(() => {
    view(visible)
  }, [view, visible])

  useEffect(() => {
    if (ready.current) toPage({ type: 'theme', colors: terminalColors[scheme] })
  }, [scheme, toPage])

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

  const client = server ? new ApiClient(server) : null
  const meta = { serverId }

  const state = useQuery({
    queryKey: stateKey(serverId),
    queryFn: client ? () => client.get<StateView>('/state') : skipToken,
    meta
  })
  const agent = useQuery({
    queryKey: ['agent', serverId, machine, name],
    queryFn: client ? () => client.get<AgentInfo>(`${sessionPath}/agent`) : skipToken,
    refetchInterval: 3000,
    enabled: visible && !ended,
    meta
  })

  const session = state.data?.sessions.find((s) => s.machine === machine && s.tmux === name)
  const folder = session?.folder || name
  const agentName = agent.data?.agent ?? session?.agent ?? ''

  const failed = (what: string) => (error: unknown) =>
    Alert.alert(what, error instanceof Error ? error.message : String(error))

  const answer = (keys: string) => {
    client?.post(`${sessionPath}/keys`, { keys }).catch(failed('Could not send the reply'))
    setTimeout(() => client?.post(`${sessionPath}/agent`).catch(() => {}), 400)
  }

  const stop = () => {
    Alert.alert('Stop this session?', `${folder} on ${machine} will be stopped.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Stop',
        style: 'destructive',
        onPress: () => {
          client
            ?.post(`${sessionPath}/stop`)
            .then(() => router.back())
            .catch(failed('Could not stop the session'))
        }
      }
    ])
  }

  if (server === null) {
    return (
      <View style={{ flex: 1, padding: 24, paddingTop: insets.top + 24, backgroundColor: theme.background }}>
        <Text style={{ color: theme.foreground, fontSize: 16 }}>This server is no longer paired with the phone.</Text>
        <Pressable onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: theme.mutedForeground, fontSize: 16 }}>Back</Text>
        </Pressable>
      </View>
    )
  }

  const banner =
    ended ?? (term.status === 'reconnecting' ? 'Reconnecting...' : term.status === 'connecting' ? 'Connecting...' : null)

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, backgroundColor: terminalColors[scheme].background, paddingTop: insets.top }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 8,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderBottomColor: theme.border,
          backgroundColor: theme.background
        }}
      >
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={8} style={{ padding: 8 }}>
          <Text style={{ color: theme.foreground, fontSize: 18 }}>‹</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ color: theme.foreground, fontSize: 16, fontWeight: '600' }}>
            {folder}
          </Text>
          <Text numberOfLines={1} style={{ color: theme.mutedForeground, fontSize: 13 }}>
            {[agentName, machine].filter(Boolean).join('  ·  ')}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={stop}
          disabled={!client || !!ended}
          style={({ pressed }) => ({
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 8,
            opacity: ended ? 0.5 : 1,
            backgroundColor: pressed ? theme.accent : theme.muted
          })}
        >
          <Text style={{ color: theme.down, fontSize: 15 }}>Stop</Text>
        </Pressable>
      </View>
      {banner && (
        <View style={{ paddingHorizontal: 16, paddingVertical: 6, backgroundColor: theme.muted }}>
          <Text style={{ color: theme.foreground, fontSize: 13 }}>{banner}</Text>
        </View>
      )}
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
      <QuickReplies info={ended ? undefined : agent.data} onKeys={answer} onCancel={() => term.send(ESC)} />
      <View style={{ paddingBottom: insets.bottom, backgroundColor: theme.background }}>
        <KeyBar mods={mods} onToggle={(mod) => setMods((m) => ({ ...m, [mod]: !m[mod] }))} onKey={onKey} />
      </View>
    </KeyboardAvoidingView>
  )
}
