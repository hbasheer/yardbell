import { useIsFocused, useRouter } from 'expo-router'
import { ChevronLeft, ChevronRight, ExternalLink, MessageSquare, MoreHorizontal, Server, Square, SquareTerminal, Trash2, Workflow } from 'lucide-react-native'
import { useRef, useState } from 'react'
import { Linking, Pressable, RefreshControl, ScrollView, Text, View, type HostInstance } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { NoticeBanner } from '../changes/NoticeBanner'
import { dispatchHref } from '../dispatch/listModel'
import { sessionHref } from '../home/presentation'
import type { PairedServer } from '../servers/store'
import { useServerState } from '../state/useServerState'
import { ConfirmModal } from '../ui/ConfirmModal'
import { ListGroup } from '../ui/ListGroup'
import { NavBar } from '../ui/NavBar'
import { NavBarButton } from '../ui/NavBarButton'
import { PullDownMenu } from '../ui/PullDownMenu'
import type { ActionSheetAction } from '../ui/ActionSheet'
import { LoadErrorState, StateView } from '../ui/StateView'
import { colors, feedback, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import { useAppActive } from '../ui/useAppActive'
import { acceptTool, answerRun, continueRun, deleteRun, dropRun, retryRun, setTokenLimit, stopRunSession } from './api'
import { clock, nodeState, runLabel, silentPass, type Definition, type Run, type Step } from './model'
import { NeedBox, type NeedAction } from './NeedBox'
import { HistoryList, Section, StatusPill, StepMark, TokenBar, noteColor } from './parts'
import { StepSheet } from './StepSheet'
import { pipelinesKey, useGuardedTask, useRefetchOnChange, useRefetchWhenResumed, useRun } from './queries'
import {
  deleteRunConfirm,
  dropConfirm,
  heldText,
  historyRows,
  isEnded,
  pipelineHref,
  reachedSteps,
  reportParts,
  runChips,
  startedLine,
  stopSessionConfirm,
  tokenBar,
  type Confirm,
  type RunChip
} from './screenModel'

type Terminal = NonNullable<Run['terminals']>[number]
type Asking = { kind: 'drop' } | { kind: 'delete' } | { kind: 'stop'; terminal: Terminal }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : 'Could not read the run.')

export function RunScreen({ server, runId, pipelineHint, multipleServers }: { server: PairedServer; runId: string; pipelineHint: string; multipleServers: boolean }) {
  useColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const focused = useIsFocused()
  const appActive = useAppActive()
  const { busy, notice, setNotice, run } = useGuardedTask(server.id, [pipelinesKey(server.id)])
  const poll = focused && appActive && busy === null
  const query = useRun(server, runId, pipelineHint, poll)
  const { state } = useServerState(server)
  const [asking, setAsking] = useState<Asking | null>(null)
  const [stepId, setStepId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const menuRef = useRef<HostInstance>(null)

  useRefetchOnChange(state?.runs_waiting, () => query.refetch().catch(() => {}))
  useRefetchWhenResumed(poll, () => query.refetch().catch(() => {}))

  const r = query.data
  const d = r?.definition
  const ended = r ? isEnded(r) : false

  const act = async (action: NeedAction, value?: string | number): Promise<boolean> => {
    const id = runId
    const done = await run(action, async () => {
      if (action === 'answer') await answerRun(server, id, String(value ?? ''))
      else if (action === 'retry') await retryRun(server, id)
      else if (action === 'accept-tool') await acceptTool(server, id)
      else if (action === 'token-limit') await setTokenLimit(server, id, Number(value))
      else await continueRun(server, id, action)
      return true
    })
    return done === true
  }

  const confirmAsked = () => {
    const ask = asking
    if (!ask || !r) return
    if (ask.kind === 'drop') void run('drop', () => dropRun(server, runId))
    else if (ask.kind === 'stop') void run(`stop:${ask.terminal.name}`, () => stopRunSession(server, runId, ask.terminal.name))
    else
      void run('delete', async () => {
        await deleteRun(server, runId)
        router.back()
      })
  }

  const openChip = (chip: RunChip) => {
    if (chip.kind === 'conversation') router.push(dispatchHref(server.id, chip.id) as never)
    else if (chip.kind !== 'place') Linking.openURL(chip.url).catch((error) => setNotice({ kind: 'error', text: `Could not open ${chip.url}: ${messageOf(error)}` }))
  }

  const openSession = (machine: string, name: string) => {
    const href = sessionHref({ serverId: server.id, machine, tmux: name })
    if (href) router.push(href as never)
  }

  const pull = async () => {
    setRefreshing(true)
    await query.refetch().catch(() => {})
    setRefreshing(false)
  }

  const menu: ActionSheetAction[] = r
    ? [
        ...(ended
          ? [{ label: 'Delete this run', icon: Trash2, destructive: true, disabled: busy !== null, onPress: () => setAsking({ kind: 'delete' }) }]
          : r.state === 'queued' || r.state === 'running'
            ? [{ label: 'Stop this run', icon: Square, destructive: true, disabled: busy !== null, onPress: () => setAsking({ kind: 'drop' }) }]
            : []),
        { label: 'Open the pipeline', icon: Workflow, onPress: () => router.push(pipelineHref(server.id, r.pipeline) as never) }
      ]
    : []

  let confirm: Confirm | null = null
  if (asking && r) confirm = asking.kind === 'drop' ? dropConfirm(r) : asking.kind === 'delete' ? deleteRunConfirm(r) : stopSessionConfirm(asking.terminal)

  let body
  if (query.isPending) body = <StateView loading title="Loading the run" />
  else if (!r) body = <LoadErrorState message={messageOf(query.error)} onRetry={() => query.refetch()} />
  else if (!d) body = <StateView title="This run has no pipeline shape" message="The server sent the run without its definition." />
  else
    body = (
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
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
        <View style={styles.head}>
          <StatusPill run={r} />
          <Text style={styles.label} selectable>
            {runLabel(r)}
          </Text>
          <Text style={styles.meta}>{startedLine(r, d)}</Text>
          <Chips chips={runChips(r)} onOpen={openChip} />
        </View>
        {query.isError ? <Text style={styles.stale}>{`Not updating: ${messageOf(query.error)}`}</Text> : null}
        {notice ? (
          <View style={styles.bleed}>
            <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />
          </View>
        ) : null}
        {r.state === 'waiting' ? <NeedBox run={r} d={d} busy={busy} act={act} onDrop={() => setAsking({ kind: 'drop' })} /> : null}
        {r.state === 'queued' && r.held ? <Held run={r} /> : null}
        <TokenView run={r} />
        {r.teardown_problem ? (
          <Text style={styles.error} accessibilityRole="alert" selectable>
            {r.teardown_problem}
          </Text>
        ) : null}
        {r.terminals?.length ? (
          <Section title="Sessions" note="live sessions of this run">
            <ListGroup surface="page">
              {r.terminals.map((t) => (
                <View key={t.name} style={styles.session}>
                  <Pressable
                    onPress={() => openSession(t.machine, t.name)}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${t.label}`}
                    style={({ pressed }) => [styles.sessionMain, pressed && styles.pressed]}
                  >
                    <SquareTerminal size={18} color={colors.textSecondary} strokeWidth={2} />
                    <View style={styles.main}>
                      <View style={styles.inline}>
                        <Text style={styles.rowTitle} numberOfLines={1}>
                          {t.label}
                        </Text>
                        {t.current ? <Text style={styles.live}>Live</Text> : null}
                      </View>
                      <Text style={styles.meta} numberOfLines={1}>{`${t.name} on ${t.machine}`}</Text>
                    </View>
                  </Pressable>
                  <Pressable
                    onPress={() => setAsking({ kind: 'stop', terminal: t })}
                    disabled={busy !== null}
                    accessibilityRole="button"
                    accessibilityLabel={`Stop session ${t.name}`}
                    hitSlop={6}
                    style={({ pressed }) => [styles.stop, busy !== null && styles.disabled, pressed && styles.pressed]}
                  >
                    <Text style={styles.stopText}>{busy === `stop:${t.name}` ? 'Stopping' : 'Stop'}</Text>
                  </Pressable>
                </View>
              ))}
            </ListGroup>
          </Section>
        ) : null}
        {r.sessions_left?.length ? (
          <Section title="Still open" note="sessions that outlived the run">
            <ListGroup surface="page">
              {r.sessions_left.map((t) => (
                <Pressable
                  key={t.name}
                  onPress={() => openSession(t.machine, t.name)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${t.name}`}
                  style={({ pressed }) => [styles.sessionMain, styles.sessionPad, pressed && styles.pressed]}
                >
                  <SquareTerminal size={18} color={colors.textSecondary} strokeWidth={2} />
                  <Text style={[styles.rowTitle, styles.main]} numberOfLines={1}>{`${t.name} on ${t.machine}`}</Text>
                  <ChevronRight size={16} color={colors.textMuted} strokeWidth={2} />
                </Pressable>
              ))}
            </ListGroup>
          </Section>
        ) : null}
        <Steps run={r} d={d} onPick={setStepId} />
        {r.report ? (
          <Section title="Report">
            <View style={styles.report}>
              <Text style={styles.reportText} selectable>
                {r.report}
              </Text>
            </View>
          </Section>
        ) : null}
        {r.history?.length ? (
          <Section title="History" note="every step it entered, in order">
            <HistoryList rows={historyRows(r, d)} clockOf={(at) => clock(at)} />
          </Section>
        ) : null}
      </ScrollView>
    )

  const step = d && stepId ? (d.steps.find((s) => s.id === stepId) ?? null) : null

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <NavBar
        leading={<NavBarButton icon={ChevronLeft} accessibilityLabel="Back" onPress={() => router.back()} />}
        title={r ? runLabel(r) : 'Run'}
        subtitle={r ? [r.pipeline_name || r.pipeline, multipleServers ? server.machine : ''].filter(Boolean).join(' · ') : undefined}
        refreshing={query.isFetching && !query.isPending}
        trailing={
          r ? (
            <View ref={menuRef} collapsable={false}>
              <NavBarButton icon={MoreHorizontal} accessibilityLabel="More for this run" active={menuOpen} onPress={() => setMenuOpen(true)} />
            </View>
          ) : undefined
        }
      />
      <View style={styles.fill}>{body}</View>
      <PullDownMenu visible={menuOpen} anchorRef={menuRef} groups={[menu]} onClose={() => setMenuOpen(false)} />
      {r && d ? (
        <StepSheet
          server={server}
          run={r}
          d={d}
          step={step}
          onClose={() => setStepId(null)}
          onOpenConversation={() => {
            setStepId(null)
            if (r.conversation) router.push(dispatchHref(server.id, r.conversation) as never)
          }}
        />
      ) : null}
      <ConfirmModal
        visible={asking !== null}
        title={confirm?.title ?? ''}
        message={confirm?.body}
        confirmLabel={confirm?.confirm}
        destructive
        onConfirm={confirmAsked}
        onCancel={() => setAsking(null)}
      />
    </View>
  )
}

function Chips({ chips, onOpen }: { chips: RunChip[]; onOpen: (chip: RunChip) => void }) {
  useColorScheme()
  if (!chips.length) return null
  return (
    <View style={styles.chips}>
      {chips.map((chip) => {
        const Icon = chip.kind === 'conversation' ? MessageSquare : chip.kind === 'place' ? Server : ExternalLink
        const still = chip.kind === 'place'
        return (
          <Pressable
            key={`${chip.kind}:${chip.label}`}
            onPress={() => onOpen(chip)}
            disabled={still}
            accessibilityRole={still ? undefined : chip.kind === 'conversation' ? 'button' : 'link'}
            accessibilityLabel={chip.label}
            style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
          >
            {chip.kind === 'conversation' || still ? <Icon size={12} color={colors.textMuted} strokeWidth={2} /> : null}
            <Text style={styles.chipText} numberOfLines={1}>
              {chip.label}
            </Text>
            {chip.kind !== 'conversation' && !still ? <Icon size={12} color={colors.textMuted} strokeWidth={2} /> : null}
          </Pressable>
        )
      })}
    </View>
  )
}

function Held({ run }: { run: Run }) {
  useColorScheme()
  const held = heldText(run)
  if (!held) return null
  if (held.plain) return <Text style={styles.meta}>{held.reason}</Text>
  return (
    <View style={styles.held} accessibilityRole="summary">
      <Text style={styles.body}>
        <Text style={styles.strong}>Held</Text>
        {` · ${held.reason}`}
      </Text>
      {held.help ? <Text style={styles.meta}>{held.help}</Text> : null}
    </View>
  )
}

function TokenView({ run }: { run: Run }) {
  const bar = tokenBar(run)
  return bar ? <TokenBar bar={bar} /> : null
}

function Steps({ run, d, onPick }: { run: Run; d: Definition; onPick: (id: string) => void }) {
  useColorScheme()
  const reached = reachedSteps(run, d)
  if (!reached.length) return null
  return (
    <Section title="Steps" note={`${reached.length} of ${d.steps.length}`}>
      <View style={styles.timeline}>
        <View style={styles.spine} />
        {reached.map((st) => (
          <StepRow key={st.id} run={run} step={st} onPress={() => onPick(st.id)} />
        ))}
      </View>
    </Section>
  )
}

function StepRow({ run, step, onPress }: { run: Run; step: Step; onPress: () => void }) {
  useColorScheme()
  const state = run.steps![step.id]
  const n = nodeState(run, step)
  const [open, setOpen] = useState(false)
  const report = state.report ? reportParts(state.report) : null
  return (
    <View style={styles.stepRow}>
      <StepMark state={n} />
      <View style={styles.main}>
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${step.name}, ${n.note}`} accessibilityHint="Shows the step and its transcript" hitSlop={4}>
          <Text style={styles.stepLine}>
            <Text style={styles.rowTitle}>{`${step.name}  `}</Text>
            <Text style={[styles.meta, { color: noteColor(n.cls) }]}>{n.note}</Text>
          </Text>
        </Pressable>
        {state.overridden ? <Text style={styles.warn}>Passed by a person after its command failed</Text> : null}
        {silentPass(step, state) ? <Text style={styles.warn}>Passed without a report. Check its transcript before trusting the next step.</Text> : null}
        {state.pin?.head ? (
          <Text style={styles.meta}>
            {'Read '}
            <Text style={styles.mono}>{state.pin.head.slice(0, 7)}</Text>
            {state.pin.changes ? ' with uncommitted changes' : ''}
          </Text>
        ) : null}
        {report ? (
          report.rest ? (
            <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button" accessibilityState={{ expanded: open }}>
              <Text style={styles.meta}>{open ? `${report.head}\n${report.rest}` : `${report.head}…`}</Text>
            </Pressable>
          ) : (
            <Text style={styles.meta}>{report.head}</Text>
          )
        ) : null}
      </View>
      <Text style={styles.time}>{clock(state.ended || state.started)}</Text>
    </View>
  )
}


const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  fill: { flex: 1 },
  content: { gap: spacing.lg, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  head: { gap: spacing.sm },
  bleed: { marginHorizontal: -spacing.lg, marginTop: -spacing.sm },
  label: { fontSize: 17, lineHeight: 23, fontWeight: '700', color: colors.textPrimary },
  meta: { fontSize: typography.metaSize, lineHeight: 17, color: colors.textMuted },
  body: { fontSize: 13, lineHeight: 19, color: colors.textPrimary },
  strong: { fontWeight: '700' },
  warn: { fontSize: typography.metaSize, lineHeight: 17, color: colors.statusAmber },
  error: { fontSize: typography.metaSize, lineHeight: 17, color: colors.statusRed },
  stale: { fontSize: typography.metaSize, color: colors.statusAmber },
  mono: { fontFamily: typography.monoFamily, fontSize: 11, color: colors.textSecondary },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 28,
    maxWidth: '100%',
    paddingHorizontal: 10,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  chipText: { fontSize: typography.metaSize, color: colors.textSecondary, flexShrink: 1 },
  held: { gap: spacing.xs, padding: spacing.md, borderRadius: radii.control, backgroundColor: colors.bgPanel },
  session: { flexDirection: 'row', alignItems: 'center', paddingRight: spacing.md },
  sessionMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingLeft: spacing.lg, paddingVertical: spacing.md },
  sessionPad: { paddingRight: spacing.lg },
  main: { flex: 1, minWidth: 0, gap: 3 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowTitle: { fontSize: 14, fontWeight: '600', color: colors.textPrimary, flexShrink: 1 },
  live: { fontSize: 10, fontWeight: '700', color: colors.statusGreen },
  stop: { minHeight: 32, paddingHorizontal: spacing.md, borderRadius: radii.control, borderWidth: 1, borderColor: colors.statusRed, justifyContent: 'center' },
  stopText: { fontSize: 13, fontWeight: '600', color: colors.statusRed },
  timeline: { position: 'relative', gap: 2 },
  spine: { position: 'absolute', left: 11.5, top: 12, bottom: 12, width: 1, backgroundColor: colors.borderSubtle },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: 6 },
  stepLine: { fontSize: 14, lineHeight: 22 },
  time: { fontSize: 11, lineHeight: 22, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  report: { padding: spacing.md, borderRadius: radii.control, backgroundColor: colors.bgPanel },
  reportText: { fontFamily: typography.monoFamily, fontSize: typography.metaSize, lineHeight: 18, color: colors.textPrimary },
  disabled: { opacity: feedback.disabledOpacity },
  pressed: { opacity: feedback.pressedOpacity }
}))
