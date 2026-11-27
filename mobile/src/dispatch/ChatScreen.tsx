import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { AlarmClock, ChevronLeft, Ellipsis, MessagesSquare, Plus, Trash2, X } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, Text, View, type HostInstance } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ServerError } from '../api/client'
import { routeIfSignedOut } from '../api/signedOut'
import { sessionHref } from '../home/presentation'
import type { PairedServer } from '../servers/store'
import { useServerState } from '../state/useServerState'
import { ConfirmModal } from '../ui/ConfirmModal'
import { NavBar, NavBarSubtitleText } from '../ui/NavBar'
import { NavBarButton } from '../ui/NavBarButton'
import { PullDownMenu } from '../ui/PullDownMenu'
import { LoadErrorState, StateView } from '../ui/StateView'
import { colors, spacing, themedStyleSheet, useColorScheme } from '../ui/theme'
import { useKeyboardHeight } from '../ui/useKeyboardHeight'
import { attachmentSource, deleteConversation, getRunsOn, listPrompts } from './api'
import { getTriggers, setTriggerEnabled, type TriggerList } from '../settings/serverApi'
import { triggerStanding } from './cards'
import { backendNote, dockOf, liveLookup, shownPending, starters, trackedRows } from './chatModel'
import { Intro, SessionsStrip } from './chatParts'
import { Composer } from './composer'
import { BUSY_DELETE, dispatchHref, newChatHref, promptsHref } from './listModel'
import { promptToRun } from './prompts/model'
import { PendingDock } from './PendingDock'
import { Transcript } from './Transcript'
import { MicButton } from './voice/MicButton'
import { stopSpeaking, useSpokenReplies } from './voice/useSpokenReplies'
import { useConversation } from './useConversation'

const DOCK_BODY = 160
const DOCK_BODY_TYPING = 72

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function ChatScreen({ server, routeId, run, serverCount }: { server: PairedServer; routeId: string; run?: string; serverCount: number }) {
  useColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const keyboardUp = useKeyboardHeight().height > 0
  const queryClient = useQueryClient()
  const { state } = useServerState(server)
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [fill, setFill] = useState<{ text: string; at: number } | undefined>()
  const [triggers, setTriggers] = useState<TriggerList | null>(null)
  const menuRef = useRef<HostInstance>(null)

  const onCreated = useCallback((id: string) => router.setParams({ id, run: undefined }), [router])
  const onMoved = useCallback((id: string) => router.push(dispatchHref(server.id, id) as never), [router, server.id])
  const chat = useConversation(server, routeId, onCreated, onMoved)
  const { reload } = chat

  const runsOn = useQuery({ queryKey: ['dispatch', 'runs-on', server.id], queryFn: () => getRunsOn(server), staleTime: 30_000 })
  const prompts = useQuery({ queryKey: ['dispatch', 'prompts', server.id], queryFn: () => listPrompts(server), staleTime: 15_000 })

  const waitingOnServer = state?.waiting
  const firstWaiting = useRef(true)
  useEffect(() => {
    if (waitingOnServer === undefined) return
    if (firstWaiting.current) {
      firstWaiting.current = false
      return
    }
    void reload()
  }, [waitingOnServer, reload])

  const triggerName = chat.meta.trigger?.name
  useEffect(() => {
    if (!triggerName) return
    let live = true
    getTriggers(server).then(
      (list) => live && setTriggers(list),
      () => {}
    )
    return () => {
      live = false
    }
  }, [server, triggerName])

  const toggleTrigger = useCallback(
    async (enabled: boolean) => {
      if (!triggerName) return
      setTriggers(await setTriggerEnabled(server, triggerName, enabled))
    },
    [server, triggerName]
  )

  const openSession = useCallback(
    (machine: string, name: string) => {
      const href = sessionHref({ serverId: server.id, machine, tmux: name })
      if (href) router.push(href as never)
    },
    [router, server.id]
  )

  const source = useCallback((file: string) => (chat.id ? attachmentSource(server, chat.id, file) : null), [server, chat.id])

  const dock = useMemo(() => dockOf(chat.events), [chat.events])
  const shown = shownPending(dock.steps, chosen)
  const live = useMemo(() => liveLookup(state), [state])
  const machines = useMemo(() => state?.machines.map((machine) => machine.name), [state])
  const agents = useMemo(() => state?.agents?.map(({ name, label }) => ({ name, label })), [state])
  const tracked = useMemo(() => trackedRows(chat.meta.sessions, state), [chat.meta.sessions, state])
  const note = chat.id ? backendNote(runsOn.data, chat.meta.backend) : null

  useSpokenReplies(chat.events, !chat.loading && !chat.loadError, routeId === 'new')

  const send = useCallback(
    async (payload: Parameters<typeof chat.send>[0]) => {
      stopSpeaking()
      setChosen(null)
      await chat.send(payload)
      queryClient.invalidateQueries({ queryKey: ['state', server.id] }).catch(() => {})
    },
    [chat.send, queryClient, server.id]
  )

  const [runError, setRunError] = useState<string | null>(null)
  const ran = useRef(false)
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(() => {
    if (!run || routeId !== 'new' || ran.current) return
    if (prompts.isError && !prompts.data) {
      setRunError(`Could not load the saved prompts to run "${run}": ${messageOf(prompts.error)}`)
      return
    }
    if (!prompts.data) return
    setRunError(null)
    ran.current = true
    const prompt = promptToRun(prompts.data, run)
    if (!prompt) {
      setRunError(`The saved prompt "${run}" no longer exists.`)
      return
    }
    sendRef.current({ text: prompt.text, attachments: [], task: { name: prompt.name, version: prompt.version } }).catch((error) =>
      setRunError(`Could not run "${prompt.name}": ${messageOf(error)}`)
    )
  }, [run, routeId, prompts.data, prompts.isError, prompts.error])

  const confirmDelete = async () => {
    setDeleting(false)
    if (!chat.id) return
    setDeleteError(null)
    try {
      await deleteConversation(server, chat.id)
      if (router.canGoBack()) router.back()
      else router.replace('/')
    } catch (error) {
      if (routeIfSignedOut(error, server.id)) return
      setDeleteError(error instanceof ServerError && error.status === 409 ? BUSY_DELETE : `Could not delete the chat: ${messageOf(error)}`)
    }
  }

  const menu = [
    [
      { label: 'New chat', icon: Plus, onPress: () => router.push(newChatHref(server.id) as never) },
      { label: 'Saved prompts', icon: MessagesSquare, onPress: () => router.push(promptsHref(server.id) as never) }
    ],
    ...(chat.id ? [[{ label: 'Delete', icon: Trash2, destructive: true, onPress: () => setDeleting(true) }]] : [])
  ]

  const intro = chat.id === null && chat.events.length === 0
  const failure = deleteError ?? runError
  const notice = failure ? { tone: 'error' as const, text: failure } : chat.notice

  let body
  if (intro) body = <Intro prompts={starters(prompts.data ?? [])} runsOn={runsOn.data} onPick={(text) => setFill({ text, at: Date.now() })} />
  else if (chat.loading && chat.events.length === 0) body = <StateView loading title="Loading the chat" />
  else if (chat.loadError && chat.events.length === 0) body = <LoadErrorState message={chat.loadError} onRetry={() => void reload()} />
  else
    body = (
      <Transcript
        events={chat.events}
        busy={chat.busy}
        streaming={chat.streaming}
        since={chat.since}
        trigger={chat.meta.trigger}
        standing={chat.meta.trigger ? triggerStanding(triggers, chat.meta.trigger.name) : null}
        onToggleTrigger={toggleTrigger}
        note={note}
        actions={chat.actions}
        live={live}
        machines={machines}
        agents={agents}
        prompts={prompts.data ?? []}
        shownStep={shown?.id ?? null}
        onShowStep={setChosen}
        onOpenSession={openSession}
        source={source}
      />
    )

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <NavBar
        title={chat.meta.title || (chat.id ? 'Chat' : 'New chat')}
        titleLeading={chat.meta.trigger ? <AlarmClock size={15} color={colors.textMuted} strokeWidth={2} /> : undefined}
        subtitle={serverCount > 1 ? <NavBarSubtitleText>{server.machine}</NavBarSubtitleText> : undefined}
        leading={
          <NavBarButton icon={ChevronLeft} accessibilityLabel="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        }
        trailing={
          <View ref={menuRef} collapsable={false}>
            <NavBarButton icon={Ellipsis} accessibilityLabel="More" active={menuOpen} onPress={() => setMenuOpen(true)} />
          </View>
        }
      />
      <SessionsStrip rows={tracked} onOpen={openSession} />
      {body}
      {notice ? (
        <View style={styles.notice} accessibilityRole="alert">
          <Text style={[styles.noticeText, notice.tone === 'error' && styles.error]} numberOfLines={3}>
            {notice.text}
          </Text>
          <Pressable
            onPress={() => {
              setDeleteError(null)
              setRunError(null)
              chat.dismissNotice()
            }}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          >
            <X size={14} color={colors.textMuted} strokeWidth={2.2} />
          </Pressable>
        </View>
      ) : null}
      {shown && chat.id ? (
        <PendingDock
          pending={dock.steps}
          all={dock.all}
          shown={shown}
          bodyMaxHeight={keyboardUp ? DOCK_BODY_TYPING : DOCK_BODY}
          onDecide={chat.actions.decide}
          onDecideAll={chat.decideEvery}
          onOpenSession={openSession}
          machines={machines}
          agents={agents}
        />
      ) : null}
      <Composer
        server={server}
        conversationId={chat.id}
        busy={chat.busy}
        backend={chat.meta.backend ?? runsOn.data?.runs_on}
        onSend={send}
        onStop={() => void chat.stop()}
        fill={fill}
        micSlot={(mic) => <MicButton server={server} runsOn={runsOn.data} onText={mic.insert} onProblem={mic.notify} />}
      />
      <PullDownMenu visible={menuOpen} anchorRef={menuRef} groups={menu} onClose={() => setMenuOpen(false)} />
      <ConfirmModal
        visible={deleting}
        title="Delete this chat?"
        message={chat.meta.title || undefined}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(false)}
      />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.xs,
    paddingTop: spacing.xs
  },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  error: { color: colors.statusRed }
}))
