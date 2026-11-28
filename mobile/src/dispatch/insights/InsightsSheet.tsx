import { useQuery } from '@tanstack/react-query'
import { FlaskConical, GitPullRequest, SquareTerminal } from 'lucide-react-native'
import { useRef, useState } from 'react'
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from 'react-native'
import type { PairedServer } from '../../servers/store'
import { ActionButton } from '../../ui/ActionButton'
import { BottomDrawer } from '../../ui/BottomDrawer'
import { SheetHeader } from '../../ui/SheetHeader'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../../ui/theme'
import { sessionInsights } from '../api'
import type { InsightMark, InsightPart, Insights } from '../types'
import {
  aboutOf,
  EMPTY_TITLE,
  emptyBody,
  factsOf,
  fromLine,
  hour,
  duration,
  insightsIntro,
  MEANS,
  partLines,
  partSaid,
  pullWord,
  SHOWN,
  spentCards,
  spentNote,
  statusOf,
  stepTotal,
  SUGGEST_HELP,
  suggestionOf,
  timelineNote,
  timelineOf,
  times,
  WORDS,
  type InsightState,
  type Suggestion,
  type TimelineItem
} from './model'

export type InsightsTarget = { machine: string; name: string }

type Props = {
  server: PairedServer
  target: InsightsTarget | null
  onClose: () => void
  onSuggest: (suggestion: Suggestion) => void
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function InsightsSheet({ server, target, onClose, onSuggest }: Props) {
  useColorScheme()
  const [shown, setShown] = useState(target)
  if (target && (target.machine !== shown?.machine || target.name !== shown?.name)) setShown(target)
  return (
    <BottomDrawer visible={target !== null} onClose={onClose} fillAvailable contentScrollable={false}>
      {shown ? <InsightsBody server={server} target={shown} onClose={onClose} onSuggest={onSuggest} /> : null}
    </BottomDrawer>
  )
}

function InsightsBody({ server, target, onClose, onSuggest }: Omit<Props, 'target'> & { target: InsightsTarget }) {
  useColorScheme()
  const query = useQuery({
    queryKey: ['insights', server.id, target.machine, target.name],
    queryFn: () => sessionInsights(server, target.machine, target.name),
    gcTime: 0,
    retry: false,
    meta: { serverId: server.id }
  })
  const [all, setAll] = useState(false)
  const suggested = useRef(false)
  const data = query.data
  const status = data ? statusOf(data) : null

  const suggest = () => {
    if (!data || suggested.current) return
    suggested.current = true
    onClose()
    onSuggest(suggestionOf(data))
  }

  return (
    <View style={styles.fill}>
      <SheetHeader title={target.name} subtitle={insightsIntro(target.machine, target.name, Boolean(data))} onClose={onClose} />
      <ScrollView style={styles.fill} contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {query.isError ? (
          <Text style={styles.error} accessibilityRole="alert" selectable>
            {messageOf(query.error)}
          </Text>
        ) : !data ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.textSecondary} />
            <Text style={styles.help}>{`Reading ${target.name} on ${target.machine}`}</Text>
          </View>
        ) : (
          <Body data={data} status={status} all={all} onAll={() => setAll(true)} />
        )}
      </ScrollView>
      <View style={styles.footer}>
        {data ? <Text style={styles.help}>{SUGGEST_HELP}</Text> : null}
        <View style={styles.buttons}>
          <ActionButton label="Close" variant="ghost" onPress={onClose} />
          {data ? <ActionButton label="Suggest a better prompt" onPress={suggest} /> : null}
        </View>
      </View>
    </View>
  )
}

function Body({ data, status, all, onAll }: { data: Insights; status: ReturnType<typeof statusOf> | null; all: boolean; onAll: () => void }) {
  useColorScheme()
  const t = data.timeline
  const about = aboutOf(data)
  const facts = factsOf(data)
  const { items, told } = timelineOf(data)
  const hidden = all ? 0 : Math.max(0, items.length - SHOWN)
  const spent = t ? spentCards(t) : null
  const barTotal = t ? t.periods.reduce((n, p) => n + p.seconds, 0) : 0
  const pull = data.pull
  return (
    <View style={styles.gap}>
      {status ? (
        <View style={[styles.pill, status.tone === 'ok' && styles.pillOk, status.tone === 'warn' && styles.pillWarn]}>
          <Text style={[styles.pillText, status.tone === 'ok' && styles.okText, status.tone === 'warn' && styles.warnText]}>{status.word}</Text>
        </View>
      ) : null}
      {about ? (
        <View style={styles.box}>
          <Text style={styles.text}>{about}</Text>
        </View>
      ) : null}
      <View style={styles.facts}>
        {facts.map((fact) => (
          <View key={fact.name} style={styles.fact}>
            <Text style={styles.factName}>{fact.name}</Text>
            <Text style={styles.factValue} numberOfLines={1}>
              {fact.value}
            </Text>
          </View>
        ))}
      </View>
      {pull ? (
        <Pressable onPress={() => void Linking.openURL(pull.url).catch(() => {})} accessibilityRole="link" style={styles.pull}>
          <GitPullRequest size={14} color={colors.textMuted} strokeWidth={2} />
          <Text style={styles.pullText} numberOfLines={1}>{`#${pull.number} ${pull.title}`}</Text>
          <Text style={styles.pullWord}>{pullWord(pull)}</Text>
        </Pressable>
      ) : null}
      {t && !t.started ? (
        <Text style={styles.help}>{`It was already running when Yardbell started watching it, so the figures below start at ${factsOf(data).find((f) => f.name === 'Watched since')?.value ?? ''}.`}</Text>
      ) : null}

      {t && spent ? (
        <>
          <Section title="Time spent" note={spentNote(t)}>
            {barTotal > 0 ? (
              <View style={styles.bar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                {t.periods.map((p, i) => (
                  <View key={i} style={[styles.seg, { flexGrow: Math.max(p.seconds, barTotal / 400), backgroundColor: stateColor(p.state) }]} />
                ))}
              </View>
            ) : null}
            <View style={styles.cards}>
              {spent.cards.map((card) => (
                <View key={card.state} style={styles.card} accessibilityHint={MEANS[card.state]}>
                  <View style={styles.cardHead}>
                    <View style={[styles.dot, { backgroundColor: stateColor(card.state) }]} />
                    <Text style={styles.factName}>{WORDS[card.state]}</Text>
                  </View>
                  <Text style={styles.big}>{card.amount}</Text>
                  {card.sub ? <Text style={styles.small}>{card.sub}</Text> : null}
                </View>
              ))}
              <View style={styles.card}>
                <View style={styles.cardHead}>
                  <FlaskConical size={12} color={colors.textMuted} strokeWidth={2} />
                  <Text style={styles.factName}>{spent.tests.title}</Text>
                </View>
                <Text style={styles.big}>{spent.tests.amount}</Text>
                {spent.tests.sub ? <Text style={styles.small}>{spent.tests.sub}</Text> : null}
              </View>
            </View>
          </Section>
          {items.length > 0 ? (
            <Section title="Timeline" note={timelineNote(data, told)}>
              {t.dropped > 0 ? <Text style={styles.small}>{`${times(t.dropped, 'older change')} no longer kept.`}</Text> : null}
              {hidden > 0 ? (
                <Pressable onPress={onAll} accessibilityRole="button" hitSlop={6}>
                  <Text style={styles.link}>{`Show ${hidden} earlier`}</Text>
                </Pressable>
              ) : null}
              {!hidden && data.parts?.before && partSaid(data.parts.before) ? (
                <View style={styles.entry}>
                  <Text style={styles.entryTitle}>Before Yardbell was watching</Text>
                  <Part part={data.parts.before} />
                </View>
              ) : null}
              {items.slice(hidden).map((item) => (
                <Entry key={item.key} item={item} />
              ))}
            </Section>
          ) : null}
        </>
      ) : (
        <View style={styles.empty}>
          <Text style={styles.entryTitle}>{EMPTY_TITLE}</Text>
          <Text style={styles.help}>{emptyBody(data.machine)}</Text>
        </View>
      )}

      {data.work?.screen ? (
        <Section title="End of its terminal" note="Yardbell can only read what happened in each stretch from Claude Code's sessions.">
          <Mono text={data.work.screen} />
        </Section>
      ) : null}
      {data.scrollback_error ? <Text style={styles.help}>{`Could not read the scrollback: ${data.scrollback_error}`}</Text> : null}
      {data.earlier.length > 0 ? (
        <Section title="Earlier, from the scrollback" note="Tool calls and test runs on the screen from before Yardbell recorded them, oldest first. Their times are not known.">
          {data.earlier.map((run, i) => (
            <Run key={i} run={run} at="" />
          ))}
        </Section>
      ) : null}
      {data.task || data.from ? (
        <Section title="Task" note={data.task ? 'The prompt this session started with.' : undefined}>
          {data.task ? <Mono text={data.task} /> : null}
          {data.from ? <Text style={styles.help}>{fromLine(data.from)}</Text> : null}
        </Section>
      ) : null}
    </View>
  )
}

const stateColor = (state: InsightState) => (state === 'working' ? colors.statusGreen : state === 'waiting' ? colors.statusAmber : colors.textMuted)

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  useColorScheme()
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
      {note ? <Text style={styles.small}>{note}</Text> : null}
      {children}
    </View>
  )
}

function Mono({ text }: { text: string }) {
  useColorScheme()
  return (
    <ScrollView style={styles.mono} nestedScrollEnabled>
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
        <Text style={styles.monoText} selectable>
          {text}
        </Text>
      </ScrollView>
    </ScrollView>
  )
}

function Run({ run, at }: { run: Omit<InsightMark, 'at'>; at: string }) {
  useColorScheme()
  const Icon = run.kind === 'pull' ? GitPullRequest : run.kind === 'test' ? FlaskConical : SquareTerminal
  return (
    <View style={styles.run}>
      <Text style={styles.time}>{at}</Text>
      <Icon size={13} color={colors.textMuted} strokeWidth={2} />
      <Text style={[styles.runText, run.kind !== 'pull' && styles.runMono]} numberOfLines={1}>
        {run.text}
      </Text>
      {run.ok === true ? <Text style={[styles.result, styles.okText]}>Passed</Text> : null}
      {run.ok === false ? <Text style={[styles.result, styles.badText]}>Failed</Text> : null}
    </View>
  )
}

function Entry({ item }: { item: TimelineItem }) {
  useColorScheme()
  if (item.kind === 'run') return <Run run={item.run} at={hour(item.at)} />
  if (item.kind === 'ended') {
    return (
      <View style={styles.entry}>
        <View style={styles.entryHead}>
          <Text style={styles.time}>{hour(item.at)}</Text>
          <View style={[styles.dot, { backgroundColor: colors.textPrimary }]} />
          <Text style={styles.entryTitle}>Ended</Text>
        </View>
      </View>
    )
  }
  const { period, part } = item
  return (
    <View style={styles.entry}>
      <View style={styles.entryHead}>
        <Text style={styles.time}>{hour(period.from)}</Text>
        <View style={[styles.dot, { backgroundColor: stateColor(period.state) }]} />
        <Text style={styles.entryTitle}>{WORDS[period.state]}</Text>
        <Text style={styles.small}>{period.to ? `for ${duration(period.seconds)}` : `${duration(period.seconds)} so far`}</Text>
      </View>
      {part && partSaid(part) ? <Part part={part} /> : null}
    </View>
  )
}

function Part({ part }: { part: InsightPart }) {
  useColorScheme()
  const [open, setOpen] = useState(false)
  const total = stepTotal(part)
  return (
    <View style={styles.part}>
      {partLines(part).map((line, i) => (
        <View key={i} style={styles.line}>
          <Text style={[styles.lineWho, line.warn && styles.warnText]}>{line.who}</Text>
          <Text style={styles.lineText} numberOfLines={6}>
            {line.text}
          </Text>
        </View>
      ))}
      {total > 0 ? (
        <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} hitSlop={6}>
          <Text style={styles.small}>{open ? 'Hide steps' : `Show ${times(total, 'step')}`}</Text>
        </Pressable>
      ) : null}
      {open ? (
        <View style={styles.steps}>
          {part.more ? <Text style={[styles.small, styles.italic]}>{`${times(part.more, 'older step')} not shown.`}</Text> : null}
          {part.did.map((step, i) => (
            <Text key={i} style={styles.small}>{`${i + 1}. ${step.what}`}</Text>
          ))}
        </View>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  fill: { flex: 1 },
  body: { paddingTop: spacing.sm, paddingBottom: spacing.xl },
  gap: { gap: spacing.lg },
  loading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.lg },
  help: { fontSize: 12, lineHeight: 17, color: colors.textSecondary },
  small: { fontSize: 12, lineHeight: 17, color: colors.textMuted },
  italic: { fontStyle: 'italic' },
  error: { fontSize: 13, lineHeight: 19, color: colors.statusRed },
  text: { fontSize: 13, lineHeight: 19, color: colors.textPrimary },
  link: { fontSize: 12, fontWeight: '600', color: colors.accentBlue },
  pill: { alignSelf: 'flex-start', paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radii.control, backgroundColor: colors.sheetGroup },
  pillOk: { backgroundColor: colors.diffAddedBg },
  pillWarn: { backgroundColor: colors.sheetGroup },
  pillText: { fontSize: 11, fontWeight: '600', color: colors.textSecondary },
  okText: { color: colors.statusGreen },
  warnText: { color: colors.statusAmber },
  badText: { color: colors.statusRed },
  box: { padding: spacing.md, borderRadius: radii.control, backgroundColor: colors.sheetGroup },
  facts: { flexDirection: 'row', flexWrap: 'wrap', rowGap: spacing.sm, columnGap: spacing.lg },
  fact: { width: '45%' },
  factName: { fontSize: 11, color: colors.textMuted },
  factValue: { fontSize: 13, color: colors.textPrimary },
  pull: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, borderRadius: radii.control, borderWidth: 1, borderColor: colors.borderSubtle },
  pullText: { flex: 1, fontSize: 13, color: colors.textPrimary },
  pullWord: { fontSize: 11, fontWeight: '600', color: colors.textSecondary },
  section: { gap: spacing.sm },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  bar: { flexDirection: 'row', height: 10, gap: 1, borderRadius: 5, overflow: 'hidden', backgroundColor: colors.sheetGroup },
  seg: { flexBasis: 0 },
  cards: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  card: { width: '48%', flexGrow: 1, padding: spacing.md, borderRadius: radii.control, borderWidth: 1, borderColor: colors.borderSubtle, backgroundColor: colors.bgPanel },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  big: { marginTop: 4, fontSize: 18, fontWeight: '600', color: colors.textPrimary },
  entry: { gap: 4, paddingVertical: 4 },
  entryHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  entryTitle: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  time: { width: 52, fontSize: 12, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  run: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 2 },
  runText: { flex: 1, fontSize: 12, color: colors.textPrimary },
  runMono: { fontFamily: typography.monoFamily, fontSize: 11.5 },
  result: { fontSize: 11, fontWeight: '600' },
  part: { gap: 4, marginLeft: 60, padding: spacing.sm, borderRadius: radii.tile, backgroundColor: colors.sheetGroup },
  line: { flexDirection: 'row', gap: spacing.sm },
  lineWho: { width: 70, fontSize: 12, fontWeight: '500', color: colors.textMuted },
  lineText: { flex: 1, fontSize: 12, lineHeight: 17, color: colors.textPrimary },
  steps: { gap: 2 },
  empty: { padding: spacing.lg, gap: spacing.xs, borderRadius: radii.control, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.borderSubtle },
  mono: { maxHeight: 220, padding: spacing.md, borderRadius: radii.control, backgroundColor: colors.sheetGroup },
  monoText: { fontFamily: typography.monoFamily, fontSize: 12, lineHeight: 17, color: colors.textPrimary },
  footer: { gap: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm }
}))
