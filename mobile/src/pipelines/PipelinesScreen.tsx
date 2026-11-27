import { useIsFocused, useRouter } from 'expo-router'
import { ArrowRight, Check, ChevronLeft, Repeat } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, Switch, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { NoticeBanner } from '../changes/NoticeBanner'
import { Segmented } from '../inbox/Segmented'
import type { PairedServer } from '../servers/store'
import { useServerState } from '../state/useServerState'
import { ListGroup } from '../ui/ListGroup'
import { NavBar } from '../ui/NavBar'
import { NavBarButton } from '../ui/NavBarButton'
import { LoadErrorState, StateView } from '../ui/StateView'
import { colors, feedback, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import { useAppActive } from '../ui/useAppActive'
import { setPipelineEnabled, type ListedPipeline } from './api'
import { countsWord, flow, triggerWords, type BriefRun, type ConnectorInfo } from './model'
import { Badge, KindTile, RunDot } from './parts'
import { pipelinesKey, useBriefRuns, useGuardedTask, usePipelineList, useRefetchOnChange, useRefetchWhenResumed } from './queries'
import { briefLabel, pipelineHref, runHref, sortPipelines, triggerIcon, waitingAge, waitingReason, waitingRuns } from './screenModel'

type Tab = 'list' | 'waiting'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : 'Could not read the pipelines.')

export function PipelinesScreen({ server, multipleServers }: { server: PairedServer; multipleServers: boolean }) {
  useColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const focused = useIsFocused()
  const appActive = useAppActive()
  const [view, setView] = useState<Tab>('list')
  const { busy, notice, setNotice, run } = useGuardedTask(server.id, [pipelinesKey(server.id)])
  const poll = focused && appActive && busy === null
  const list = usePipelineList(server, poll)
  const brief = useBriefRuns(server, poll)
  const { state } = useServerState(server)

  const refetchAll = () => {
    list.refetch().catch(() => {})
    brief.refetch().catch(() => {})
  }
  useRefetchOnChange(state?.runs_waiting, refetchAll)
  useRefetchWhenResumed(poll, refetchAll)

  const pipelines = useMemo(() => sortPipelines(list.data?.pipelines ?? []), [list.data])
  const waiting = useMemo(() => waitingRuns(brief.data ?? []), [brief.data])
  const connectors = list.data?.connectors ?? []

  const setEnabled = (p: ListedPipeline, on: boolean) =>
    run(`enabled:${p.definition.id}`, () => setPipelineEnabled(server, p.definition.id, on))

  const [refreshing, setRefreshing] = useState(false)
  const pull = async () => {
    setRefreshing(true)
    await Promise.all([list.refetch(), brief.refetch()]).catch(() => {})
    setRefreshing(false)
  }

  let body
  if (list.isPending) body = <StateView loading title="Loading pipelines" />
  else if (!list.data) body = <LoadErrorState message={messageOf(list.error)} onRetry={() => list.refetch()} />
  else if (view === 'list' && pipelines.length === 0)
    body = (
      <StateView
        iconElement={<KindTile kind="start" size={48} />}
        title="No pipelines yet"
        message="A pipeline runs agents step by step on a ticket or pull request: plan, implement, review, push, report. Build one on the web or ask Dispatch."
      />
    )
  else if (view === 'waiting' && waiting.length === 0)
    body = (
      <StateView
        iconElement={<Check size={28} color={colors.textMuted} strokeWidth={2} />}
        title="Nothing is waiting for you"
        message="When a run stops for an approval, an answer or a failed check, it shows up here."
      />
    )
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
        {view === 'list' ? (
          <ListGroup surface="page">
            {pipelines.map((p) => (
              <PipelineRow
                key={p.definition.id}
                pipeline={p}
                connectors={connectors}
                disabled={busy !== null}
                onOpen={() => router.push(pipelineHref(server.id, p.definition.id) as never)}
                onToggle={(on) => void setEnabled(p, on)}
              />
            ))}
          </ListGroup>
        ) : (
          <ListGroup surface="page">
            {waiting.map((r) => (
              <WaitingRow key={r.id} run={r} onOpen={() => router.push(runHref(server.id, r.id, r.pipeline) as never)} />
            ))}
          </ListGroup>
        )}
      </ScrollView>
    )

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <NavBar
        leading={<NavBarButton icon={ChevronLeft} accessibilityLabel="Back" onPress={() => router.back()} />}
        title="Pipelines"
        subtitle={multipleServers ? server.machine : undefined}
        refreshing={(list.isFetching || brief.isFetching) && !list.isPending}
      />
      <Segmented<Tab>
        segments={[
          { id: 'list', label: 'Pipelines', count: list.data ? pipelines.length : undefined },
          { id: 'waiting', label: 'Waiting for me', count: brief.data ? waiting.length : undefined }
        ]}
        value={view}
        onChange={setView}
      />
      {brief.isError && view === 'waiting' ? <Text style={styles.stale}>{`Not updating: ${messageOf(brief.error)}`}</Text> : null}
      {notice ? <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} /> : null}
      <View style={styles.fill}>{body}</View>
    </View>
  )
}

function FlowLine({ steps }: { steps: { name: string; loop: string }[] }) {
  useColorScheme()
  if (!steps.length) return <Text style={styles.meta}>No steps yet</Text>
  return (
    <View style={styles.flow} accessibilityLabel={`Steps: ${steps.map((s) => s.name).join(', ')}`}>
      {steps.map((s, at) => (
        <View key={at} style={styles.flowItem}>
          {at > 0 ? <ArrowRight size={11} color={colors.textMuted} strokeWidth={2} /> : null}
          <Text style={styles.flowStep} numberOfLines={1}>
            {s.name}
          </Text>
          {s.loop ? (
            <View style={styles.flowItem}>
              <Repeat size={11} color={colors.textMuted} strokeWidth={2} />
              <Text style={styles.meta} numberOfLines={1}>
                {s.loop}
              </Text>
            </View>
          ) : null}
        </View>
      ))}
    </View>
  )
}

function PipelineRow({
  pipeline,
  connectors,
  disabled,
  onOpen,
  onToggle
}: {
  pipeline: ListedPipeline
  connectors: ConnectorInfo[]
  disabled: boolean
  onOpen: () => void
  onToggle: (on: boolean) => void
}) {
  useColorScheme()
  const d = pipeline.definition
  const runs = pipeline.runs
  return (
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={d.name} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <KindTile kind={triggerIcon(d.trigger?.kind)} filled={d.enabled} size={36} />
      <View style={styles.main}>
        <View style={styles.titleLine}>
          <Text style={styles.title} numberOfLines={1}>
            {d.name}
          </Text>
          <Badge text={`v${d.version}`} tone="plain" />
        </View>
        {runs.waiting || runs.running ? (
          <View style={styles.badges}>
            {runs.waiting ? <Badge text={`${runs.waiting} waiting for you`} tone="wait" /> : null}
            {runs.running ? <Badge text={`${runs.running} running`} tone="run" /> : null}
          </View>
        ) : null}
        <Text style={styles.secondary} numberOfLines={2}>
          {triggerWords(d.trigger, connectors)}
        </Text>
        <FlowLine steps={flow(d)} />
        {pipeline.problem ? (
          <Text style={styles.problem} numberOfLines={2}>
            {pipeline.problem}
          </Text>
        ) : null}
        <Text style={styles.meta}>{countsWord(runs)}</Text>
      </View>
      <View style={styles.toggle}>
        <Text style={[styles.meta, d.enabled && styles.on]}>{d.enabled ? 'On' : 'Off'}</Text>
        <Switch
          value={d.enabled}
          disabled={disabled}
          onValueChange={onToggle}
          trackColor={{ true: colors.accentBlue }}
          accessibilityLabel={`${d.name} on`}
        />
      </View>
    </Pressable>
  )
}

function WaitingRow({ run, onOpen }: { run: BriefRun; onOpen: () => void }) {
  useColorScheme()
  const label = briefLabel(run)
  return (
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${label}, ${waitingReason(run)}`} style={({ pressed }) => [styles.row, styles.rowCentred, pressed && styles.pressed]}>
      <RunDot run={run} />
      <View style={styles.main}>
        <Text style={styles.title} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.secondary} numberOfLines={2}>
          {`${run.pipeline_name || run.pipeline} · ${waitingReason(run)}`}
        </Text>
      </View>
      <Text style={styles.meta}>{waitingAge(run)}</Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  fill: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  stale: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, fontSize: typography.metaSize, color: colors.statusAmber },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  rowCentred: { alignItems: 'center' },
  pressed: { opacity: feedback.pressedOpacity },
  main: { flex: 1, minWidth: 0, gap: 5 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  secondary: { fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  meta: { fontSize: typography.metaSize, color: colors.textMuted },
  on: { color: colors.textPrimary },
  problem: { fontSize: typography.metaSize, color: colors.statusRed },
  flow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
  flowItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  flowStep: {
    fontSize: 11,
    color: colors.textSecondary,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: 'hidden'
  },
  toggle: { alignItems: 'center', gap: 2 }
}))
