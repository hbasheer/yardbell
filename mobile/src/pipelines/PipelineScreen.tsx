import { useQuery } from '@tanstack/react-query'
import { useIsFocused, useRouter } from 'expo-router'
import { ChevronLeft, MessageSquare, MoreHorizontal, Play, Trash2 } from 'lucide-react-native'
import { useMemo, useRef, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, Switch, Text, View, type HostInstance } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { NoticeBanner } from '../changes/NoticeBanner'
import { newChatHref } from '../dispatch/listModel'
import { Segmented } from '../inbox/Segmented'
import type { PairedServer } from '../servers/store'
import { useServerState } from '../state/useServerState'
import { ConfirmModal } from '../ui/ConfirmModal'
import { ListGroup } from '../ui/ListGroup'
import { NavBar } from '../ui/NavBar'
import { NavBarButton } from '../ui/NavBarButton'
import { PullDownMenu } from '../ui/PullDownMenu'
import { LoadErrorState, StateView } from '../ui/StateView'
import { colors, feedback, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import { useAppActive } from '../ui/useAppActive'
import { clearEndedRuns, pipelineHistory } from './api'
import {
  clock,
  describe,
  nodeState,
  runLabel,
  stateWord,
  triggerWords,
  type ConnectorInfo,
  type Definition,
  type Run
} from './model'
import { Badge, KindTile, noteColor, RunDot, StepMark } from './parts'
import { listKey, pipelinesKey, runsKey, useEnabledSwitch, useGuardedTask, usePipelineList, usePipelineRuns, useRefetchOnChange, useRefetchWhenResumed } from './queries'
import { RunNowSheet } from './RunNowSheet'
import {
  askDispatchText,
  clearedWord,
  clearEndedConfirm,
  isEnded,
  markRun,
  nextWords,
  nodeOrder,
  noRunsText,
  runHref,
  triggerIcon
} from './screenModel'

type Tab = 'runs' | 'steps' | 'history'

const messageOf = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback)

export function PipelineScreen({ server, id, multipleServers }: { server: PairedServer; id: string; multipleServers: boolean }) {
  useColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const focused = useIsFocused()
  const appActive = useAppActive()
  const { busy, notice, setNotice, run } = useGuardedTask(server.id, () => [listKey(server.id), runsKey(server.id, id)])
  const poll = focused && appActive && busy === null
  const list = usePipelineList(server, poll)
  const runsQuery = usePipelineRuns(server, id, poll)
  const { state } = useServerState(server)
  const [tab, setTab] = useState<Tab | null>(null)
  const [runNow, setRunNow] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const menuRef = useRef<HostInstance>(null)

  const refetchAll = () => {
    list.refetch().catch(() => {})
    runsQuery.refetch().catch(() => {})
  }
  useRefetchOnChange(state?.runs_waiting, refetchAll)
  useRefetchWhenResumed(poll, refetchAll)

  const listed = list.data?.pipelines.find((p) => p.definition.id === id)
  const d = listed?.definition
  const runs = useMemo(() => runsQuery.data ?? [], [runsQuery.data])
  const ended = useMemo(() => runs.filter(isEnded), [runs])
  const shown: Tab = tab ?? (runsQuery.data && runs.length === 0 ? 'steps' : 'runs')

  const pull = async () => {
    setRefreshing(true)
    await Promise.all([list.refetch(), runsQuery.refetch()]).catch(() => {})
    setRefreshing(false)
  }

  const enabled = useEnabledSwitch(server.id, run)
  const clearEnded = () =>
    run('clear', async () => {
      const out = await clearEndedRuns(server, id)
      setNotice({ kind: 'info', text: clearedWord(out.deleted.length) })
    })

  const askDispatch = () => d && router.push(`${newChatHref(server.id)}?ask=${encodeURIComponent(askDispatchText(d))}` as never)

  let body
  if (list.isPending) body = <StateView loading title="Loading the pipeline" />
  else if (!list.data) body = <LoadErrorState message={messageOf(list.error, 'Could not read the pipelines.')} onRetry={() => list.refetch()} />
  else if (!d) body = <StateView title="There is no such pipeline" message="It may have been deleted." />
  else
    body = (
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void pull()}
            tintColor={colors.textSecondary}
            colors={[colors.textSecondary]}
            progressBackgroundColor={colors.bgRaised}
          />
        }
      >
        {shown === 'runs' ? (
          <RunsTab
            d={d}
            runs={runs}
            loading={runsQuery.isPending}
            error={runsQuery.isError ? messageOf(runsQuery.error, 'Could not read the runs.') : null}
            endedCount={ended.length}
            busy={busy !== null}
            clearBusy={busy === 'clear'}
            onClear={() => setClearing(true)}
            onOpen={(r) => router.push(runHref(server.id, r.id, d.id) as never)}
          />
        ) : shown === 'steps' ? (
          <StepsTab d={d} connectors={list.data.connectors ?? []} markFrom={markRun(runs)} />
        ) : (
          <HistoryTab server={server} d={d} />
        )}
      </ScrollView>
    )

  const clearText = clearEndedConfirm(ended)

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <NavBar
        leading={<NavBarButton icon={ChevronLeft} accessibilityLabel="Back" onPress={() => router.back()} />}
        title={d?.name ?? 'Pipeline'}
        subtitle={d ? [`v${d.version}`, multipleServers ? server.machine : ''].filter(Boolean).join(' · ') : undefined}
        refreshing={(list.isFetching || runsQuery.isFetching) && !list.isPending}
        trailing={
          d ? (
            <>
              <NavBarButton
                icon={Play}
                accessibilityLabel="Run now"
                disabled={busy !== null}
                onPress={() => {
                  setNotice(null)
                  setRunNow(true)
                }}
              />
              <View ref={menuRef} collapsable={false}>
                <NavBarButton icon={MoreHorizontal} accessibilityLabel="More for this pipeline" active={menuOpen} onPress={() => setMenuOpen(true)} />
              </View>
            </>
          ) : undefined
        }
      />
      {d ? (
        <View style={styles.header}>
          <Text style={styles.trigger} numberOfLines={2}>
            {triggerWords(d.trigger, list.data?.connectors ?? [])}
          </Text>
          <View style={styles.switchRow}>
            <Text style={[styles.meta, enabled.valueOf(d) && styles.on]}>{enabled.valueOf(d) ? 'On' : 'Off'}</Text>
            <Switch
              value={enabled.valueOf(d)}
              disabled={busy !== null}
              onValueChange={(on) => enabled.toggle(server, d, on)}
              trackColor={{ true: colors.accentBlue }}
              accessibilityLabel={`${d.name} on`}
            />
          </View>
        </View>
      ) : null}
      {listed?.problem ? <Text style={styles.problem}>{listed.problem}</Text> : null}
      {d ? (
        <Segmented<Tab>
          segments={[
            { id: 'runs', label: 'Runs', count: runsQuery.data ? runs.length : undefined },
            { id: 'steps', label: 'Steps', count: d.steps.length },
            { id: 'history', label: 'History' }
          ]}
          value={shown}
          onChange={setTab}
        />
      ) : null}
      {notice ? <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} /> : null}
      <View style={styles.fill}>{body}</View>
      <PullDownMenu
        visible={menuOpen}
        anchorRef={menuRef}
        groups={[
          [
            { label: 'Run now', icon: Play, disabled: busy !== null, onPress: () => setRunNow(true) },
            { label: 'Ask Dispatch', icon: MessageSquare, onPress: askDispatch },
            ...(ended.length
              ? [{ label: 'Clear ended', icon: Trash2, destructive: true, disabled: busy !== null, onPress: () => setClearing(true) }]
              : [])
          ]
        ]}
        onClose={() => setMenuOpen(false)}
      />
      {d ? (
        <RunNowSheet
          visible={runNow}
          server={server}
          d={d}
          busy={busy}
          notice={notice}
          onDismissNotice={() => setNotice(null)}
          run={run}
          onClose={() => {
            setRunNow(false)
            if (notice?.kind === 'error') setNotice(null)
          }}
          onStarted={(text) => {
            setRunNow(false)
            setTab('runs')
            setNotice({ kind: 'info', text })
          }}
        />
      ) : null}
      <ConfirmModal
        visible={clearing}
        title={clearText.title}
        message={clearText.body}
        confirmLabel={clearText.confirm}
        destructive
        onConfirm={() => void clearEnded()}
        onCancel={() => setClearing(false)}
      />
    </View>
  )
}

function RunsTab({
  d,
  runs,
  loading,
  error,
  endedCount,
  busy,
  clearBusy,
  onClear,
  onOpen
}: {
  d: Definition
  runs: Run[]
  loading: boolean
  error: string | null
  endedCount: number
  busy: boolean
  clearBusy: boolean
  onClear: () => void
  onOpen: (run: Run) => void
}) {
  useColorScheme()
  if (loading) return <StateView loading title="Loading runs" />
  if (error && !runs.length) return <Text style={styles.problem}>{error}</Text>
  if (!runs.length) return <Text style={styles.note}>{noRunsText(d.trigger.kind)}</Text>
  return (
    <View style={styles.gap}>
      {endedCount > 0 ? (
        <View style={styles.toolRow}>
          <Text style={styles.meta}>{`${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`}</Text>
          <Pressable
            onPress={onClear}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Clear ended"
            accessibilityHint="Delete every run that has ended"
            style={({ pressed }) => [styles.toolButton, busy && styles.disabled, pressed && styles.pressed]}
          >
            <Trash2 size={14} color={colors.textSecondary} strokeWidth={2} />
            <Text style={styles.toolText}>{clearBusy ? 'Clearing' : 'Clear ended'}</Text>
          </Pressable>
        </View>
      ) : null}
      <ListGroup surface="page">
        {runs.map((r) => (
          <Pressable
            key={r.id}
            onPress={() => onOpen(r)}
            accessibilityRole="button"
            accessibilityLabel={runLabel(r)}
            style={({ pressed }) => [styles.runRow, pressed && styles.pressed]}
          >
            <RunDot run={r} />
            <View style={styles.main}>
              <Text style={styles.title} numberOfLines={1}>
                {runLabel(r)}
              </Text>
              <Text style={[styles.secondary, r.state === 'waiting' && styles.waiting]} numberOfLines={1}>
                {stateWord(r, r.definition || d)}
              </Text>
            </View>
          </Pressable>
        ))}
      </ListGroup>
    </View>
  )
}

function StepsTab({ d, connectors, markFrom }: { d: Definition; connectors: ConnectorInfo[]; markFrom: Run | null }) {
  useColorScheme()
  const shape = markFrom
  const steps = nodeOrder(d)
  return (
    <View style={styles.gap}>
      {shape ? <Text style={styles.meta}>{`Marks from ${runLabel(shape)}`}</Text> : null}
      <View style={styles.nodes}>
        <View style={styles.spine} />
        <Node kind={triggerIcon(d.trigger.kind)} name="Trigger" who={triggerWords(d.trigger, connectors)} />
        {steps.length === 0 ? <Text style={styles.note}>No steps yet</Text> : null}
        {steps.map((s) => {
          const info = describe(s, connectors)
          const state = nodeState(shape, s)
          return (
            <Node
              key={s.id}
              kind={s.kind}
              name={s.name}
              who={info.who}
              does={info.does}
              tags={info.tags}
              next={nextWords(d, s)}
              mark={shape ? state : undefined}
              detached={s.id !== d.start && !d.steps.some((o) => Object.values(o.next).includes(s.id))}
            />
          )
        })}
      </View>
    </View>
  )
}

function Node({
  kind,
  name,
  who,
  does,
  tags = [],
  next = [],
  mark,
  detached = false
}: {
  kind: string
  name: string
  who: string
  does?: string
  tags?: string[]
  next?: string[]
  mark?: ReturnType<typeof nodeState>
  detached?: boolean
}) {
  useColorScheme()
  return (
    <View style={styles.node} accessibilityLabel={[name, who, does, mark?.note].filter(Boolean).join(', ')}>
      <KindTile kind={kind} size={30} />
      <View style={styles.nodeCard}>
        <View style={styles.nodeHead}>
          <Text style={styles.title} numberOfLines={1}>
            {name}
          </Text>
          {mark && mark.cls !== 'later' && mark.cls !== '' ? (
            <View style={styles.nodeMark}>
              <StepMark state={mark} />
            </View>
          ) : null}
        </View>
        {who ? (
          <Text style={styles.secondary} numberOfLines={2}>
            {who}
          </Text>
        ) : null}
        {does ? (
          <Text style={styles.does} numberOfLines={3}>
            {does}
          </Text>
        ) : null}
        {tags.length ? (
          <View style={styles.tags}>
            {tags.map((t) => (
              <Badge key={t} text={t} tone="plain" />
            ))}
          </View>
        ) : null}
        {mark && mark.note ? <Text style={[styles.meta, { color: noteColor(mark.cls) }]}>{mark.note}</Text> : null}
        {next.map((line) => (
          <Text key={line} style={styles.meta} numberOfLines={1}>
            {line}
          </Text>
        ))}
        {detached ? <Text style={styles.meta}>Not connected to the other steps</Text> : null}
      </View>
    </View>
  )
}

function HistoryTab({ server, d }: { server: PairedServer; d: Definition }) {
  useColorScheme()
  const history = useQuery({
    queryKey: [...pipelinesKey(server.id), 'history', d.id, d.version],
    queryFn: () => pipelineHistory(server, d.id),
    meta: { serverId: server.id }
  })
  if (history.isPending) return <StateView loading title="Loading versions" />
  if (!history.data) return <Text style={styles.problem}>{messageOf(history.error, 'Could not read the versions.')}</Text>
  const current = history.data.current ?? history.data.history[0]?.version
  return (
    <View style={styles.gap}>
      <Text style={styles.meta}>Every saved version, newest first. Restore or delete versions on the web.</Text>
      <ListGroup surface="page">
        {history.data.history.map((v) => (
          <View key={v.version} style={styles.version}>
            <View style={styles.nodeHead}>
              <Text style={styles.title}>{`v${v.version}`}</Text>
              {v.version === current ? <Badge text="Current" tone="ok" /> : null}
              <View style={styles.fill} />
              <Text style={styles.meta}>{clock(v.saved)}</Text>
            </View>
            <View style={styles.tags}>
              {v.definition.steps.length ? (
                v.definition.steps.map((st) => <Badge key={st.id} text={st.name} tone="plain" />)
              ) : (
                <Text style={styles.meta}>No steps</Text>
              )}
            </View>
          </View>
        ))}
      </ListGroup>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  fill: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.xs },
  trigger: { flex: 1, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  on: { color: colors.textPrimary },
  problem: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, fontSize: typography.metaSize, lineHeight: 17, color: colors.statusRed },
  note: { fontSize: 13, lineHeight: 19, color: colors.textMuted },
  gap: { gap: spacing.md },
  toolRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toolButton: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 32, paddingHorizontal: spacing.sm, borderRadius: radii.control },
  toolText: { fontSize: 13, color: colors.textSecondary },
  runRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  main: { flex: 1, minWidth: 0, gap: 2 },
  title: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  secondary: { fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  waiting: { color: colors.statusAmber },
  meta: { fontSize: typography.metaSize, lineHeight: 17, color: colors.textMuted },
  does: { fontSize: 13, lineHeight: 18, color: colors.textPrimary },
  nodes: { gap: spacing.md, position: 'relative' },
  spine: { position: 'absolute', left: 14.5, top: 16, bottom: 16, width: 1, backgroundColor: colors.borderSubtle },
  node: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  nodeCard: { flex: 1, minWidth: 0, gap: 4, padding: spacing.md, borderRadius: radii.control, backgroundColor: colors.bgPanel },
  nodeHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  nodeMark: { marginLeft: 'auto' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  version: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  disabled: { opacity: feedback.disabledOpacity },
  pressed: { opacity: feedback.pressedOpacity }
}))
