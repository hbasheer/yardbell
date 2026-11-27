import { useEffect, useMemo, useState, type ComponentType } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import {
  ArrowRightLeft,
  Ban,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  GitMerge,
  Keyboard,
  Pencil,
  Play,
  Plug,
  Save,
  ScanLine,
  Search,
  Shapes,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  Trash2,
  ToggleRight,
  TriangleAlert,
  Upload,
  Workflow,
  XCircle,
  Zap,
  MessageSquare
} from 'lucide-react-native'
import { isAlreadyDecided } from '../dispatch/api'
import type { ActionEvent, Decision } from '../dispatch/types'
import { BottomDrawer } from '../ui/BottomDrawer'
import { colors, feedback, radii, spacing, themedStyleSheet, useColorScheme } from '../ui/theme'
import {
  approveLabel,
  badge,
  bodyBlocks,
  canEdit,
  editForm,
  editNote,
  editedInput,
  outcomeOf,
  rejectLabel,
  reviewOf,
  startDraft,
  StepEditError,
  stepState,
  stepTitle,
  trail,
  wantsAgain,
  whereLine,
  type Draft,
  type Tone
} from './model'
import { StepBody } from './StepBody'
import { StepEditor, type AgentChoice } from './StepEditor'
import { DiffBlock } from './DiffBlock'

type IconProps = { size?: number; color?: string; strokeWidth?: number }

const ICONS: Record<string, ComponentType<IconProps>> = {
  start_session: SquareTerminal,
  send_to_session: Keyboard,
  stop_session: Square,
  remove_worktree: Trash2,
  integrate_branches: GitMerge,
  push_branch: Upload,
  move_session: ArrowRightLeft,
  call_connector: Plug,
  save_connector: Plug,
  remember: Brain,
  change_settings: SlidersHorizontal,
  save_task: Save,
  run_trigger: Zap,
  save_pipeline: Workflow,
  set_pipeline_enabled: ToggleRight,
  run_pipeline: Play,
  answer_run: MessageSquare,
  draw_diagram: Shapes
}

export type StepCardProps = {
  step: ActionEvent
  onDecide: (decision: Decision, editedInput?: Record<string, unknown>, again?: boolean) => Promise<void>
  onOpenSession?: (machine: string, name: string) => void
  machines?: string[]
  agents?: AgentChoice[]
  bodyMaxHeight?: number
}

export function StepCard(props: StepCardProps) {
  const state = stepState(props.step)
  return state === 'pending' ? <PendingCard {...props} /> : <Receipt {...props} />
}

function iconFor(step: ActionEvent): ComponentType<IconProps> {
  const review = reviewOf(step)
  if (review?.scan) return ScanLine
  if (review) return Search
  return ICONS[step.tool] ?? SquareTerminal
}

function toneColor(tone: Tone): string {
  switch (tone) {
    case 'ok':
      return colors.statusGreen
    case 'warn':
      return colors.statusAmber
    case 'error':
      return colors.statusRed
    default:
      return colors.textMuted
  }
}

function PendingCard({ step, onDecide, machines, agents, bodyMaxHeight = 320 }: StepCardProps) {
  useColorScheme()
  const [busy, setBusy] = useState<Decision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [already, setAlready] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Draft>({})
  const Icon = iconFor(step)
  const blocks = useMemo(() => bodyBlocks(step), [step])
  const note = badge(step, 'pending')
  const form = editForm(step)
  const edit = canEdit(step) && form !== null
  const label = approveLabel(step)

  useEffect(() => {
    setAlready(false)
    setError(null)
  }, [step.id])

  async function decide(decision: Decision, input?: Record<string, unknown>) {
    setBusy(decision)
    setError(null)
    try {
      await onDecide(decision, input, wantsAgain(step, decision))
      setEditing(false)
    } catch (caught) {
      if (isAlreadyDecided(caught)) {
        setAlready(true)
        setEditing(false)
      } else {
        setError(caught instanceof Error && caught.message ? caught.message : 'The step could not be decided. Try again.')
      }
    } finally {
      setBusy(null)
    }
  }

  function approveEdited() {
    try {
      void decide('approve', editedInput(step, draft))
    } catch (caught) {
      if (!(caught instanceof StepEditError)) throw caught
      setError(caught.message)
    }
  }

  function openEditor() {
    setDraft(startDraft(step))
    setError(null)
    setEditing(true)
  }

  const was = step.tool === 'remember' && typeof step.input?.old === 'string' ? step.input.old : undefined
  const disabled = busy !== null

  return (
    <View style={styles.card} accessibilityLabel={stepTitle(step)}>
      <View style={styles.head}>
        <View style={styles.tile}>
          <Icon size={16} color={colors.textSecondary} strokeWidth={2} />
        </View>
        <View style={styles.titles}>
          <Text style={styles.title} numberOfLines={2}>
            {stepTitle(step)}
          </Text>
          <Text style={styles.where} numberOfLines={1}>
            {whereLine(step)}
          </Text>
        </View>
        <View style={[styles.badge, { borderColor: toneColor(note.tone) }]}>
          <Text style={[styles.badgeText, { color: toneColor(note.tone) }]} numberOfLines={1}>
            {note.label}
          </Text>
        </View>
      </View>

      <ScrollView style={{ maxHeight: bodyMaxHeight, flexGrow: 0 }} contentContainerStyle={styles.bodyContent} nestedScrollEnabled showsVerticalScrollIndicator={false}>
        <StepBody blocks={blocks} />
        <EditNote step={step} />
      </ScrollView>

      <Text style={styles.trail} numberOfLines={3}>
        {trail(step, busy ? 'running' : 'pending', busy)}
      </Text>

      {already ? (
        <View style={styles.noteRow} accessibilityRole="alert">
          <Clock size={14} color={colors.textMuted} strokeWidth={2} />
          <Text style={styles.noteText}>Already decided</Text>
        </View>
      ) : (
        <>
          {error && !editing ? (
            <Text style={styles.error} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          <View style={styles.footer}>
            <FooterButton label={rejectLabel(step)} onPress={() => void decide('reject')} disabled={disabled} busy={busy === 'reject'} />
            {edit ? <FooterButton label="Edit" icon={Pencil} onPress={openEditor} disabled={disabled} /> : null}
            <FooterButton label={label} icon={Check} primary onPress={() => void decide('approve')} disabled={disabled} busy={busy === 'approve'} />
          </View>
        </>
      )}

      {edit && form ? (
        <BottomDrawer visible={editing} dismissible={busy === null} onClose={() => setEditing(false)}>
          <StepEditor
            form={form}
            title={stepTitle(step)}
            approveLabel={label}
            draft={draft}
            was={was}
            error={error}
            busy={busy === 'approve'}
            machines={machines}
            agents={agents}
            onChange={(key, value) => setDraft((current) => ({ ...current, [key]: value }))}
            onCancel={() => setEditing(false)}
            onSave={approveEdited}
          />
        </BottomDrawer>
      ) : null}
    </View>
  )
}

function FooterButton({
  label,
  onPress,
  icon: Icon,
  primary = false,
  disabled = false,
  busy = false
}: {
  label: string
  onPress: () => void
  icon?: ComponentType<IconProps>
  primary?: boolean
  disabled?: boolean
  busy?: boolean
}) {
  const tint = primary ? colors.bgBase : colors.textPrimary
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.primary : styles.outline,
        primary && styles.primaryGrow,
        (pressed || busy) && styles.pressed,
        disabled && !busy && styles.disabled
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={tint} /> : Icon ? <Icon size={16} color={tint} strokeWidth={2.2} /> : null}
      <Text style={[styles.buttonText, { color: tint }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  )
}

function EditNote({ step }: { step: ActionEvent }) {
  const note = editNote(step)
  if (!note) return null
  return (
    <View style={styles.edited}>
      <Text style={styles.editedText}>{note.text}</Text>
      {note.proposed !== undefined ? <DiffBlock rows={[{ op: 'same', text: note.proposed }]} label={note.proposedLabel} /> : null}
    </View>
  )
}

function Receipt({ step, onOpenSession }: StepCardProps) {
  useColorScheme()
  const [open, setOpen] = useState(false)
  const state = stepState(step)
  const note = badge(step, state)
  const outcome = outcomeOf(step, state)
  const tone = outcome?.tone ?? note.tone
  const Mark = state === 'failed' ? XCircle : state === 'done' ? CheckCircle2 : state === 'running' ? Clock : state === 'rejected' || state === 'withdrawn' ? Ban : TriangleAlert
  const blocks = useMemo(() => bodyBlocks(step), [step])
  const line = outcome ? outcome.text : note.label
  const session = outcome?.session

  return (
    <View style={styles.receipt}>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${stepTitle(step)}, ${line}`}
        style={({ pressed }) => [styles.receiptRow, pressed && styles.pressed]}
      >
        <Mark size={16} color={toneColor(tone)} strokeWidth={2} />
        <View style={styles.titles}>
          <Text style={styles.receiptTitle} numberOfLines={1}>
            {stepTitle(step)}
          </Text>
          <Text style={[styles.receiptLine, { color: tone === 'muted' || tone === 'ok' ? colors.textMuted : toneColor(tone) }]} numberOfLines={open ? undefined : 2}>
            {line}
          </Text>
        </View>
        <ChevronDown size={14} color={colors.textMuted} strokeWidth={2} style={open ? undefined : styles.closed} />
      </Pressable>
      {open ? (
        <View style={styles.details}>
          <Text style={styles.where}>{whereLine(step)}</Text>
          <StepBody blocks={blocks} />
          <EditNote step={step} />
          {outcome?.note ? <Text style={styles.warnText}>{outcome.note}</Text> : null}
          {session && onOpenSession ? (
            <Pressable onPress={() => onOpenSession(session.machine, session.name)} accessibilityRole="button" style={[styles.button, styles.outline, styles.openButton]}>
              <SquareTerminal size={16} color={colors.textPrimary} strokeWidth={2.2} />
              <Text style={[styles.buttonText, { color: colors.textPrimary }]}>Open {session.name}</Text>
            </Pressable>
          ) : null}
          <Text style={styles.trail}>{trail(step, state)}</Text>
        </View>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  card: {
    borderRadius: radii.floating,
    borderWidth: 1,
    borderColor: colors.floatingCardBorder,
    backgroundColor: colors.composerSurface,
    overflow: 'hidden',
    padding: spacing.md,
    gap: spacing.sm
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  tile: { width: 32, height: 32, borderRadius: radii.tile, backgroundColor: colors.bgRaised, alignItems: 'center', justifyContent: 'center' },
  titles: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, fontWeight: '600', lineHeight: 21, color: colors.textPrimary },
  where: { fontSize: 12, lineHeight: 17, color: colors.textMuted },
  badge: { maxWidth: 120, borderWidth: 1, borderRadius: radii.pill, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  bodyContent: { gap: spacing.sm, paddingVertical: spacing.xs },
  trail: { fontSize: 12, lineHeight: 17, color: colors.textMuted },
  error: { fontSize: 13, color: colors.statusRed, textAlign: 'center' },
  noteRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44 },
  noteText: { fontSize: 14, fontWeight: '600', color: colors.textSecondary },
  footer: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.xs },
  button: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.control,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    flexShrink: 1
  },
  primary: { backgroundColor: colors.textPrimary },
  primaryGrow: { flexGrow: 1, flexShrink: 0, flexBasis: 0, minWidth: 110 },
  outline: { borderWidth: 1, borderColor: colors.choiceBorder },
  buttonText: { fontSize: 16, fontWeight: '700', flexShrink: 1 },
  pressed: { opacity: feedback.pressedOpacity },
  disabled: { opacity: feedback.disabledOpacity },
  edited: { gap: spacing.xs },
  editedText: { fontSize: 13, color: colors.textSecondary },
  receipt: { paddingVertical: spacing.xs },
  receiptRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  receiptTitle: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  receiptLine: { fontSize: 13, lineHeight: 18 },
  details: {
    marginLeft: 7,
    paddingLeft: spacing.md,
    gap: spacing.sm,
    paddingBottom: spacing.sm,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.borderSubtle
  },
  warnText: { fontSize: 13, color: colors.statusAmber },
  openButton: { alignSelf: 'flex-start' },
  closed: { transform: [{ rotate: '-90deg' }] }
}))
