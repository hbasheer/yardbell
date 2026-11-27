import {
  ArrowRightToLine,
  ArrowUp,
  Check,
  CircleAlert,
  CircleCheck,
  Clock,
  GitPullRequest,
  Hand,
  LoaderCircle,
  Mail,
  Pause,
  Play,
  Plug,
  Signpost,
  SquareCheck,
  SquareTerminal,
  Terminal,
  Ticket,
  Webhook,
  Wrench,
  X,
  type LucideIcon
} from 'lucide-react-native'
import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { colors, feedback, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import type { BriefRun, NodeState } from './model'
import { RUN_WORD, runTone, type HistoryRow, type RunTone, type TokenBar as TokenBarValues } from './screenModel'

const KIND_ICONS: Record<string, LucideIcon> = {
  start: Play,
  manual: Hand,
  schedule: Clock,
  ticket: Ticket,
  pull: GitPullRequest,
  agent: SquareTerminal,
  plan: Signpost,
  push: ArrowUp,
  checks: CircleCheck,
  update: SquareCheck,
  call: ArrowRightToLine,
  tool: Wrench,
  command: Terminal,
  report: Mail,
  wait: Pause,
  webhook: Webhook,
  connector: Plug
}

export const kindIcon = (kind: string): LucideIcon => KIND_ICONS[kind] ?? SquareTerminal

export function KindTile({ kind, filled = false, size = 32 }: { kind: string; filled?: boolean; size?: number }) {
  useColorScheme()
  const Icon = kindIcon(kind)
  return (
    <View style={[styles.tile, { width: size, height: size }, filled && styles.tileFilled]}>
      <Icon size={Math.round(size / 2)} color={filled ? colors.bgBase : colors.textSecondary} strokeWidth={2} />
    </View>
  )
}

const toneColor = (tone: RunTone) =>
  tone === 'wait' ? colors.statusAmber : tone === 'ok' ? colors.statusGreen : tone === 'run' ? colors.accentBlue : colors.textMuted

export function RunDot({ run }: { run: Pick<BriefRun, 'state' | 'held'> }) {
  useColorScheme()
  const tone = runTone(run)
  if (tone === 'off') return <View style={[styles.dot, styles.dotOff]} />
  return <View style={[styles.dot, { backgroundColor: toneColor(tone) }]} />
}

export function StatusPill({ run }: { run: Pick<BriefRun, 'state' | 'held'> }) {
  useColorScheme()
  const tone = runTone(run)
  return (
    <View style={[styles.pill, { borderColor: toneColor(tone) }]}>
      <RunDot run={run} />
      <Text style={[styles.pillText, { color: tone === 'off' ? colors.textSecondary : toneColor(tone) }]}>{RUN_WORD[tone]}</Text>
    </View>
  )
}

export function Badge({ text, tone }: { text: string; tone: 'wait' | 'run' | 'plain' | 'ok' }) {
  useColorScheme()
  const color = tone === 'wait' ? colors.statusAmber : tone === 'run' ? colors.accentBlue : tone === 'ok' ? colors.statusGreen : colors.textMuted
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color: tone === 'plain' ? colors.textSecondary : color }]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  )
}

export function StepMark({ state }: { state: NodeState }) {
  useColorScheme()
  let mark: ReactNode = <View style={styles.later} />
  if (state.mark === '✓') mark = <Check size={14} color={colors.statusGreen} strokeWidth={2.4} />
  else if (state.mark === '✗') mark = <X size={14} color={colors.statusRed} strokeWidth={2.4} />
  else if (state.mark === '!') mark = <CircleAlert size={14} color={colors.statusAmber} strokeWidth={2.2} />
  else if (state.cls === 'now') mark = <LoaderCircle size={14} color={colors.accentBlue} strokeWidth={2.2} />
  return <View style={styles.markRing}>{mark}</View>
}

export const noteColor = (cls: NodeState['cls']) =>
  cls === 'failed' ? colors.statusRed : cls === 'waiting' ? colors.statusAmber : cls === 'now' ? colors.accentBlue : colors.textMuted

export function TokenBar({ bar }: { bar: TokenBarValues }) {
  useColorScheme()
  const fill = bar.tone === 'over' ? colors.statusRed : bar.tone === 'warn' ? colors.statusAmber : colors.mergeGreen
  return (
    <View style={styles.card}>
      <View style={styles.tokenRow}>
        <Text style={styles.body} numberOfLines={1}>
          <Text style={styles.strong}>{bar.total}</Text> used
        </Text>
        <Text style={styles.meta}>{bar.limit}</Text>
      </View>
      {bar.pct !== null ? (
        <View style={styles.track} accessibilityRole="progressbar" accessibilityLabel={`${Math.round(bar.pct)}% of the limit`}>
          <View style={[styles.fill, { width: `${bar.pct}%`, backgroundColor: fill }]} />
        </View>
      ) : null}
      {bar.pastLimit ? <Text style={styles.warn}>Past its limit. This step finishes, and the next step that uses tokens waits for you.</Text> : null}
      {bar.unknown.map((line) => (
        <Text key={line} style={styles.warn}>
          {line}
        </Text>
      ))}
      {bar.cache ? <Text style={styles.meta}>{bar.cache}</Text> : null}
    </View>
  )
}

export function Section({ title, note, trailing, children }: { title: string; note?: string; trailing?: ReactNode; children: ReactNode }) {
  useColorScheme()
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle} accessibilityRole="header" numberOfLines={1}>
          {title}
          {note ? <Text style={styles.sectionNote}>{`  ${note}`}</Text> : null}
        </Text>
        {trailing}
      </View>
      {children}
    </View>
  )
}

const historyTone = (tone: HistoryRow['tone']) =>
  tone === 'fail' ? colors.statusRed : tone === 'needs' ? colors.statusAmber : tone === 'ok' ? colors.statusGreen : tone === 'step' ? colors.textMuted : colors.textPrimary

export function HistoryList({ rows, clockOf }: { rows: HistoryRow[]; clockOf: (at: string) => string }) {
  useColorScheme()
  return (
    <View style={styles.history}>
      <View style={styles.historyLine} />
      {rows.map((row, at) => (
        <View key={at} style={styles.historyRow}>
          <Text style={styles.historyTime}>{clockOf(row.at)}</Text>
          <View style={styles.historyDotWrap}>
            <View style={[styles.historyDot, { backgroundColor: historyTone(row.tone) }]} />
          </View>
          <Text style={[styles.historyText, row.tone === 'fail' && { color: colors.statusRed }, row.tone === 'needs' && { color: colors.statusAmber }]}>
            {row.name ? <Text style={styles.strongPlain}>{`${row.name} `}</Text> : null}
            {row.word}
            {row.note ? <Text style={styles.meta}>{` · ${row.note}`}</Text> : null}
          </Text>
        </View>
      ))}
    </View>
  )
}

type ButtonProps = {
  label: string
  onPress: () => void
  variant?: 'primary' | 'outline' | 'destructive'
  icon?: LucideIcon
  disabled?: boolean
  busy?: boolean
}

export function Button({ label, onPress, variant = 'outline', icon: Icon, disabled = false, busy = false }: ButtonProps) {
  useColorScheme()
  const inert = disabled || busy
  const tint = variant === 'primary' ? colors.bgBase : variant === 'destructive' ? colors.statusRed : colors.textPrimary
  return (
    <Pressable
      onPress={onPress}
      disabled={inert}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inert, busy }}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'destructive' && styles.buttonDestructive,
        inert && styles.disabled,
        pressed && styles.pressed
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={tint} /> : Icon ? <Icon size={16} color={tint} strokeWidth={2.2} /> : null}
      <Text style={[styles.buttonText, { color: tint }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  tile: { borderRadius: radii.tile, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgRaised },
  tileFilled: { backgroundColor: colors.textPrimary },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOff: { borderWidth: 1.5, borderColor: colors.textMuted },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: 8, height: 22, borderRadius: radii.pill, borderWidth: 1 },
  pillText: { fontSize: 12, fontWeight: '600' },
  badge: { paddingHorizontal: 7, height: 20, borderRadius: radii.pill, borderWidth: 1, justifyContent: 'center', flexShrink: 0 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  later: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.textMuted, opacity: 0.5 },
  markRing: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgBase,
    alignItems: 'center',
    justifyContent: 'center'
  },
  card: { gap: spacing.sm, padding: spacing.md, borderRadius: radii.control, backgroundColor: colors.bgPanel },
  tokenRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: spacing.sm },
  body: { flexShrink: 1, fontSize: 13, color: colors.textPrimary },
  strong: { fontWeight: '700' },
  strongPlain: { fontWeight: '600', color: colors.textPrimary },
  meta: { fontSize: typography.metaSize, lineHeight: 17, color: colors.textMuted },
  warn: { fontSize: typography.metaSize, lineHeight: 17, color: colors.statusAmber },
  track: { height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.bgRaised },
  fill: { height: 6, borderRadius: 3 },
  section: { gap: spacing.sm },
  sectionHead: { flexDirection: 'row', alignItems: 'center', minHeight: 28, gap: spacing.sm },
  sectionTitle: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  sectionNote: { fontWeight: '400', color: colors.textMuted },
  history: { position: 'relative' },
  historyLine: { position: 'absolute', top: 10, bottom: 10, left: 64 + 6 + 7.5, width: 1, backgroundColor: colors.borderSubtle },
  historyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingVertical: 4 },
  historyTime: { width: 64, fontSize: typography.metaSize, lineHeight: 17, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  historyDotWrap: { width: 16, height: 17, alignItems: 'center', justifyContent: 'center' },
  historyDot: { width: 8, height: 8, borderRadius: 4, borderWidth: 2, borderColor: colors.bgBase },
  historyText: { flex: 1, fontSize: typography.metaSize, lineHeight: 17, color: colors.textSecondary },
  button: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  buttonPrimary: { backgroundColor: colors.textPrimary },
  buttonDestructive: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.statusRed },
  buttonText: { fontSize: typography.bodySize, fontWeight: '600', flexShrink: 1 },
  disabled: { opacity: feedback.disabledOpacity },
  pressed: { opacity: feedback.pressedOpacity }
}))
