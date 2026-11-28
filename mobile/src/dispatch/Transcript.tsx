import { ArrowDown, Check } from 'lucide-react-native'
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { Markdown } from '../markdown'
import type { PairedServer } from '../servers/store'
import { StepCard } from '../steps/StepCard'
import type { AgentChoice } from '../steps/StepEditor'
import { colors, feedback, radii, spacing, themedStyleSheet, useColorScheme } from '../ui/theme'
import { blocks, stepsOf, type Block } from './blocks'
import { ErrorCard, GroupCard, PullCard, ResultsCard, ReviewCard, SessionCard, ToolRun, TriggerHeader, type LiveLookup, type TriggerStanding } from './cards'
import { promptSave } from './chatModel'
import { PendingRow, UserBubble, WorkingLine } from './chatParts'
import type { CardActions } from './useConversation'
import type { ActionEvent, Decision, DispatchEvent, SavedPrompt, Trigger } from './types'

const FAB_AFTER = 240

type Source = { uri: string; headers: { Authorization: string } }

type Item =
  | { type: 'trigger'; key: string }
  | { type: 'note'; key: string; text: string }
  | { type: 'block'; key: string; block: Block; last: boolean }
  | { type: 'working'; key: string }

export type TranscriptProps = {
  events: DispatchEvent[]
  busy: boolean
  streaming: boolean
  since: number | null
  trigger: Trigger | null
  standing: TriggerStanding
  onToggleTrigger?: (enabled: boolean) => Promise<void>
  note: string | null
  actions: CardActions
  live?: LiveLookup
  machines?: string[]
  agents?: AgentChoice[]
  prompts: SavedPrompt[]
  shownStep: string | null
  onShowStep: (id: string) => void
  onOpenSession: (machine: string, name: string) => void
  onInsights?: (machine: string, name: string) => void
  source: (file: string) => Source | null
  review?: { server: PairedServer; conversation: string | null }
}

export function Transcript(props: TranscriptProps) {
  useColorScheme()
  const list = useRef<FlatList<Item>>(null)
  const [away, setAway] = useState(false)
  const { events, busy, trigger, note } = props

  const items = useMemo(() => {
    const out: Item[] = []
    if (trigger) out.push({ type: 'trigger', key: 'trigger' })
    if (note) out.push({ type: 'note', key: 'note', text: note })
    const all = blocks(events)
    all.forEach((block, at) => out.push({ type: 'block', key: `${block.kind}:${block.key}`, block, last: at === all.length - 1 }))
    if (busy) out.push({ type: 'working', key: 'working' })
    return out.reverse()
  }, [events, busy, trigger, note])

  const steps = useMemo(() => stepsOf(events), [events])

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setAway(event.nativeEvent.contentOffset.y > FAB_AFTER)
  }, [])

  const renderItem = ({ item }: { item: Item }) => {
    switch (item.type) {
      case 'trigger':
        return props.trigger ? (
          <View style={styles.row}>
            <TriggerHeader trigger={props.trigger} standing={props.standing} onToggle={props.onToggleTrigger} />
          </View>
        ) : null
      case 'note':
        return (
          <View style={styles.row}>
            <Text style={styles.note} accessibilityRole="text">
              {item.text}
            </Text>
          </View>
        )
      case 'working':
        return (
          <View style={styles.row}>
            <WorkingLine since={props.since} />
          </View>
        )
      default:
        return (
          <BlockView
            block={item.block}
            running={item.last && props.busy}
            streaming={item.last && props.streaming}
            events={events}
            steps={steps}
            actions={props.actions}
            live={props.live}
            machines={props.machines}
            agents={props.agents}
            prompts={props.prompts}
            shownStep={props.shownStep}
            onShowStep={props.onShowStep}
            onOpenSession={props.onOpenSession}
            onInsights={props.onInsights}
            source={props.source}
            review={props.review}
          />
        )
    }
  }

  return (
    <View style={styles.fill}>
      <FlatList
        ref={list}
        inverted
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        extraData={props}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onScroll={onScroll}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={64}
        accessibilityLiveRegion="polite"
      />
      {away ? (
        <Pressable
          onPress={() => list.current?.scrollToOffset({ offset: 0, animated: true })}
          accessibilityRole="button"
          accessibilityLabel="Scroll to the latest message"
          hitSlop={6}
          style={({ pressed }) => [styles.fab, pressed && styles.pressed]}
        >
          <ArrowDown size={18} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
      ) : null}
    </View>
  )
}

type BlockProps = {
  block: Block
  running: boolean
  streaming: boolean
  events: DispatchEvent[]
  steps: ReadonlyMap<string, ActionEvent>
  actions: CardActions
  live?: LiveLookup
  machines?: string[]
  agents?: AgentChoice[]
  prompts: SavedPrompt[]
  shownStep: string | null
  onShowStep: (id: string) => void
  onOpenSession: (machine: string, name: string) => void
  onInsights?: (machine: string, name: string) => void
  source: (file: string) => Source | null
  review?: { server: PairedServer; conversation: string | null }
}

const BlockView = memo(function BlockView({ block, running, streaming, events, steps, actions, live, machines, agents, prompts, shownStep, onShowStep, onOpenSession, onInsights, source, review: reviewing }: BlockProps) {
  const index = block.key
  const answer = useCallback((key: string) => actions.answer(index, key), [actions, index])
  const review = useCallback(() => actions.review(index), [actions, index])
  const reviewChild = useCallback((child: number) => actions.review(index, child), [actions, index])
  const scan = useCallback((kind: 'dead_code' | 'test_gaps' | 'security') => actions.scan(index, kind), [actions, index])
  const sendPull = useCallback(() => actions.sendPull(index), [actions, index])
  const settle = useCallback((body: Parameters<CardActions['settleReview']>[1]) => actions.settleReview(index, body), [actions, index])
  const loadTargets = useCallback(() => actions.loadTargets(index), [actions, index])
  const decideStep = useCallback((step: ActionEvent, decision: Decision, again?: boolean) => actions.decide(step, decision, undefined, again), [actions])

  if (block.kind === 'tools') {
    return (
      <View style={styles.row}>
        <ToolRun chips={block.chips} running={running} />
      </View>
    )
  }
  const event = block.event
  let body = null
  switch (event.role) {
    case 'user':
      body = <UserBubble event={event} source={source} />
      break
    case 'assistant':
      body = (
        <View style={styles.assistant}>
          <Markdown text={event.text} streaming={streaming} />
          <PromptSave events={events} index={index} prompts={prompts} actions={actions} />
        </View>
      )
      break
    case 'action':
      body =
        event.status === 'pending' ? (
          <PendingRow step={event} shown={shownStep === event.id} onShow={() => onShowStep(event.id)} />
        ) : (
          <StepCard step={event} onDecide={(decision, input, again) => actions.decide(event, decision, input, again)} onOpenSession={onOpenSession} machines={machines} agents={agents} />
        )
      break
    case 'group':
      body = (
        <GroupCard
          group={event}
          steps={steps}
          live={live}
          onDecideAll={(decision) => actions.decideGroup(event.id, decision)}
          onDecideStep={decideStep}
          onOpenSession={onOpenSession}
        />
      )
      break
    case 'results':
      body = <ResultsCard event={event} live={live} onReview={reviewChild} onOpen={onOpenSession} />
      break
    case 'session':
      body = <SessionCard event={event} onAnswer={answer} onOpen={onOpenSession} onInsights={onInsights} onReview={review} onScan={scan} />
      break
    case 'review':
      body = <ReviewCard event={event} view={reviewing?.conversation ? { server: reviewing.server, conversation: reviewing.conversation, card: index } : undefined} onSettle={settle} loadTargets={loadTargets} />
      break
    case 'pull':
      body = <PullCard event={event} step={event.sent?.step ? steps.get(event.sent.step) : null} onSend={sendPull} onOpen={onOpenSession} />
      break
    case 'error':
      body = <ErrorCard text={event.text} />
      break
    default:
      body = null
  }
  return body ? <View style={styles.row}>{body}</View> : null
})

function PromptSave({ events, index, prompts, actions }: { events: DispatchEvent[]; index: number; prompts: SavedPrompt[]; actions: CardActions }) {
  const [state, setState] = useState<{ busy: boolean; said: string | null; error: string | null }>({ busy: false, said: null, error: null })
  const offer = promptSave(events, index, prompts)
  if (!offer) return null
  const save = async () => {
    setState({ busy: true, said: null, error: null })
    try {
      const list = await actions.saveVersion(offer.from, offer.text)
      const saved = list.find((p) => p.name === offer.from.name)
      setState({
        busy: false,
        error: null,
        said: saved && saved.version !== offer.from.version ? `Saved as version ${saved.version} of ${offer.from.name}` : `${offer.from.name} already has this text`
      })
    } catch (error) {
      setState({ busy: false, said: null, error: error instanceof Error ? error.message : 'Could not save the prompt' })
    }
  }
  if (state.said) {
    return (
      <View style={styles.saved}>
        <Check size={14} color={colors.statusGreen} strokeWidth={2.2} />
        <Text style={styles.savedText} numberOfLines={2}>
          {state.said}
        </Text>
      </View>
    )
  }
  return (
    <View style={styles.saveRow}>
      <Pressable
        onPress={() => void save()}
        disabled={state.busy}
        accessibilityRole="button"
        style={({ pressed }) => [styles.saveButton, (pressed || state.busy) && styles.pressed]}
      >
        <Text style={styles.saveText} numberOfLines={1}>
          {`Save as version ${offer.from.version + 1} of ${offer.from.name}`}
        </Text>
      </Pressable>
      {state.error ? <Text style={styles.saveError}>{state.error}</Text> : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  fill: { flex: 1 },
  content: { paddingVertical: spacing.sm },
  row: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  assistant: { gap: spacing.sm },
  note: {
    fontSize: 12.5,
    lineHeight: 18,
    color: colors.textMuted,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  fab: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    width: 38,
    height: 38,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  pressed: { opacity: feedback.pressedOpacity },
  saveRow: { gap: spacing.xs, alignItems: 'flex-start' },
  saveButton: {
    minHeight: 36,
    maxWidth: '100%',
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.choiceBorder,
    justifyContent: 'center'
  },
  saveText: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  saveError: { fontSize: 13, color: colors.statusRed },
  saved: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  savedText: { flexShrink: 1, fontSize: 13, color: colors.textSecondary }
}))
