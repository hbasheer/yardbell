import { useQuery } from '@tanstack/react-query'
import { ChevronRight, RotateCw } from 'lucide-react-native'
import { useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { Markdown } from '../markdown'
import type { PairedServer } from '../servers/store'
import { BottomDrawer } from '../ui/BottomDrawer'
import { DisclosureChevron } from '../ui/DisclosureChevron'
import { NavBarButton } from '../ui/NavBarButton'
import { SheetHeader } from '../ui/SheetHeader'
import { colors, feedback, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import { stepTranscript, type StepTranscript, type TranscriptItem } from './api'
import { STEP_KINDS, clock, nodeState, type Definition, type Run, type Step } from './model'
import { HistoryList, Section } from './parts'
import { pipelinesKey } from './queries'
import { PROMPT_FOLD, historyRows, stepFacts, transcriptParts } from './screenModel'

type Props = {
  server: PairedServer
  run: Run
  d: Definition
  step: Step | null
  onClose: () => void
  onOpenConversation: () => void
}

export function StepSheet({ server, run, d, step, onClose, onOpenConversation }: Props) {
  useColorScheme()
  return (
    <BottomDrawer visible={step !== null} onClose={onClose} fillAvailable>
      {step ? <StepBody server={server} run={run} d={d} step={step} onClose={onClose} onOpenConversation={onOpenConversation} /> : null}
    </BottomDrawer>
  )
}

function StepBody({ server, run, d, step, onClose, onOpenConversation }: Props & { step: Step }) {
  useColorScheme()
  const st = run.steps?.[step.id]
  const n = nodeState(run, step)
  const facts = stepFacts(run, step, n)
  const transcript = useQuery({
    queryKey: [...pipelinesKey(server.id), 'transcript', run.id, step.id, st?.runs ?? 0, st?.ended ?? ''],
    queryFn: () => stepTranscript(server, run.id, step.id),
    enabled: Boolean(st),
    staleTime: Infinity,
    retry: false,
    meta: { serverId: server.id }
  })
  const canReread = Boolean(transcript.data?.available || transcript.isError)

  return (
    <View>
      <SheetHeader
        title={step.name}
        subtitle={`${STEP_KINDS[step.kind] || step.kind} · ${st ? n.note : 'not reached in this run'}`}
        onClose={onClose}
      />
      <View style={styles.body}>
        {!st ? <Text style={styles.help}>The run has not reached this step.</Text> : null}
        {facts.length ? (
          <View style={styles.facts}>
            {facts.map((f) => (
              <View key={f.name} style={styles.fact}>
                <Text style={styles.factName}>{f.name}</Text>
                <Text style={[styles.factValue, f.mono && styles.mono]} selectable>
                  {f.value}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {st?.overridden ? <Text style={styles.warn}>Passed by a person after its command failed.</Text> : null}
        {st?.report ? (
          <Section title="Report">
            <Text style={styles.text} selectable>
              {st.report}
            </Text>
          </Section>
        ) : null}
        {st?.details?.length ? (
          <Section title="Details">
            {st.details.map((x) => (
              <Text key={x} style={styles.text}>{`• ${x}`}</Text>
            ))}
          </Section>
        ) : null}
        {st?.answer ? (
          <Section title="Your answer">
            <Text style={styles.text} selectable>
              {st.answer}
            </Text>
          </Section>
        ) : null}
        {st?.ran ? (
          <Text style={styles.help}>
            {`Its command ${st.ran.passed ? 'passed' : 'failed'}: `}
            <Text style={styles.mono}>{st.ran.command}</Text>
          </Text>
        ) : null}
        {st ? (
          <Section title="Each time it ran">
            <HistoryList rows={historyRows(run, d, step.id)} clockOf={(at) => clock(at)} />
          </Section>
        ) : null}
        {st ? (
          <Section
            title="Transcript"
            trailing={
              canReread ? (
                <NavBarButton icon={RotateCw} accessibilityLabel="Read again" disabled={transcript.isFetching} onPress={() => void transcript.refetch()} />
              ) : undefined
            }
          >
            {transcript.isPending || (transcript.isFetching && !transcript.data) ? (
              <View style={styles.reading}>
                <ActivityIndicator size="small" color={colors.textSecondary} />
                <Text style={styles.help}>{`Reading the transcript${st.machine ? ` from ${st.machine}` : ''}`}</Text>
              </View>
            ) : transcript.isError ? (
              <Text style={styles.error} selectable>
                {transcript.error instanceof Error ? transcript.error.message : String(transcript.error)}
              </Text>
            ) : !transcript.data?.available ? (
              <View style={styles.gap}>
                <Text style={styles.help}>{transcript.data?.why}</Text>
                {run.conversation && ['plan', 'report'].includes(step.kind) ? (
                  <Pressable onPress={onOpenConversation} accessibilityRole="link" hitSlop={6}>
                    <Text style={styles.link}>Open the conversation</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : (
              <TranscriptView data={transcript.data} />
            )}
          </Section>
        ) : null}
      </View>
    </View>
  )
}

function TranscriptView({ data }: { data: StepTranscript }) {
  useColorScheme()
  const t = data.transcript
  if (!t) return null
  return (
    <View style={styles.gap}>
      {t.dropped ? <Text style={styles.help}>{`The ${t.dropped} oldest entries are left out.`}</Text> : null}
      {transcriptParts(t.items).map((part, at) =>
        part.kind === 'tools' ? (
          <View key={at} style={styles.tools}>
            {part.list.map((call, j) => (
              <ToolCall key={j} call={call} />
            ))}
          </View>
        ) : part.kind === 'prompt' ? (
          <Prompt key={at} item={part} />
        ) : (
          <Markdown key={at} text={part.text || ''} />
        )
      )}
      {t.skipped ? <Text style={styles.help}>{`${t.skipped} ${t.skipped === 1 ? 'line was' : 'lines were'} too long to read, such as large tool output.`}</Text> : null}
      {t.cut ? <Text style={styles.help}>The transcript is over 16 MB, so its end is missing here.</Text> : null}
      <Text style={styles.help}>
        {`Read only, from ${t.files.join(', ')} in `}
        <Text style={styles.mono}>{data.path}</Text>
        {` on ${data.machine}.`}
      </Text>
    </View>
  )
}

function Prompt({ item }: { item: TranscriptItem }) {
  useColorScheme()
  const text = item.text || ''
  const long = text.length > PROMPT_FOLD
  const [open, setOpen] = useState(false)
  return (
    <View style={styles.prompt}>
      <Text style={styles.meta}>{`Sent by Yardbell${item.at ? ` · ${clock(item.at)}` : ''}`}</Text>
      {long && !open ? (
        <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityHint="Shows the whole prompt">
          <Text style={styles.text}>{`${text.slice(0, 120).trim()}…`}</Text>
        </Pressable>
      ) : (
        <Text style={styles.text} selectable>
          {text}
        </Text>
      )}
    </View>
  )
}

function ToolCall({ call }: { call: TranscriptItem }) {
  useColorScheme()
  const [open, setOpen] = useState(false)
  const dot = call.failed ? colors.statusRed : call.result ? colors.statusGreen : colors.textMuted
  return (
    <View style={styles.tool}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={`${call.name}${call.failed ? ', failed' : ''}`}
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.toolHead, pressed && styles.pressed]}
      >
        <DisclosureChevron expanded={open} collapsedDeg={0} expandedDeg={90}>
          <ChevronRight size={13} color={colors.textMuted} strokeWidth={2.2} />
        </DisclosureChevron>
        <View style={[styles.toolDot, { backgroundColor: dot }]} />
        <Text style={styles.toolName} numberOfLines={1}>
          {call.name}
        </Text>
        {call.input ? (
          <Text style={[styles.mono, styles.toolInput]} numberOfLines={1}>
            {call.input}
          </Text>
        ) : null}
      </Pressable>
      {open ? (
        call.result ? (
          <ScrollView horizontal style={styles.result} contentContainerStyle={styles.resultContent}>
            <ScrollView nestedScrollEnabled style={styles.resultInner}>
              <Text style={styles.mono} selectable>
                {call.result}
              </Text>
            </ScrollView>
          </ScrollView>
        ) : (
          <Text style={[styles.help, styles.noResult]}>No result was saved.</Text>
        )
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  body: { gap: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xl },
  gap: { gap: spacing.sm },
  facts: { gap: 6, padding: spacing.md, borderRadius: radii.control, backgroundColor: colors.sheetGroup },
  fact: { flexDirection: 'row', gap: spacing.md },
  factName: { width: 92, fontSize: typography.metaSize, lineHeight: 17, color: colors.textMuted },
  factValue: { flex: 1, fontSize: typography.metaSize, lineHeight: 17, color: colors.textPrimary },
  text: { fontSize: 13, lineHeight: 19, color: colors.textPrimary },
  help: { fontSize: typography.metaSize, lineHeight: 17, color: colors.textSecondary },
  meta: { fontSize: 11, color: colors.textMuted },
  warn: { fontSize: typography.metaSize, color: colors.statusAmber },
  error: { fontSize: typography.metaSize, lineHeight: 17, color: colors.statusRed },
  link: { fontSize: typography.metaSize, color: colors.accentBlue, textDecorationLine: 'underline' },
  mono: { fontFamily: typography.monoFamily, fontSize: 11, color: colors.textPrimary },
  reading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  prompt: { gap: 2, marginLeft: spacing.xl, padding: spacing.md, borderRadius: radii.control, backgroundColor: colors.sheetGroup },
  tools: { gap: spacing.xs },
  tool: { borderRadius: radii.tile, borderWidth: 1, borderColor: colors.borderSubtle, overflow: 'hidden' },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 34, paddingHorizontal: spacing.sm },
  toolDot: { width: 6, height: 6, borderRadius: 3 },
  toolName: { flexShrink: 1, maxWidth: '60%', fontSize: typography.metaSize, fontWeight: '600', color: colors.textPrimary },
  toolInput: { flex: 1, minWidth: 0, color: colors.textMuted },
  result: { maxHeight: 260, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  resultContent: { padding: spacing.sm },
  resultInner: { maxHeight: 244 },
  noResult: { padding: spacing.sm, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  pressed: { opacity: feedback.pressedOpacity }
}))
