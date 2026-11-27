import { useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Check, Network, SquareTerminal } from 'lucide-react-native'
import { isAlreadyDecided } from '../api'
import { ruleText, wantsAgain, whereLine } from '../../steps/model'
import type { ActionEvent, Decision, GroupChild, GroupEvent } from '../types'
import { colors, spacing, themedStyleSheet, useColorScheme } from '../../ui/theme'
import { childNote, childState, groupBadge, groupGather, groupSummary, groupTrail, pendingSteps, type ChildState, type LiveLookup } from './model'
import { Buttons, CardButton, CardFrame, CardHead, ClampedText, NoteLine, Pill } from './parts'

export type GroupCardProps = {
  group: GroupEvent
  steps: ReadonlyMap<string, ActionEvent>
  live?: LiveLookup
  onDecideAll: (decision: Decision) => Promise<ActionEvent[]>
  onDecideStep: (step: ActionEvent, decision: Decision, again?: boolean) => Promise<void>
  onOpenSession?: (machine: string, name: string) => void
}

function errorText(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback
}

export function GroupCard({ group, steps, live, onDecideAll, onDecideStep, onOpenSession }: GroupCardProps) {
  useColorScheme()
  const [deciding, setDeciding] = useState<string[]>([])
  const [all, setAll] = useState<Decision | null>(null)
  const [already, setAlready] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const states = useMemo(
    () => group.children.map((child) => childState(child, child.step ? steps.get(child.step) : undefined, Boolean(child.step && deciding.includes(child.step)), live)),
    [group.children, steps, deciding, live]
  )
  const pending = pendingSteps(states)
  const badge = groupBadge(group, states)
  const busy = all !== null || deciding.length > 0

  async function decideAll(decision: Decision) {
    setAll(decision)
    setError(null)
    try {
      const decided = await onDecideAll(decision)
      const failed = decided.filter((s) => s.result && !s.result.ok).length
      if (failed) setError(`${failed} of ${decided.length === 1 ? '1 child' : `${decided.length} children`} failed to start. Each row says why.`)
    } catch (caught) {
      if (isAlreadyDecided(caught)) setAlready(true)
      else setError(errorText(caught, 'The group could not be decided. Try again.'))
    } finally {
      setAll(null)
    }
  }

  async function decideChild(step: ActionEvent, decision: Decision) {
    setDeciding((current) => [...current, step.id])
    setNotes((current) => ({ ...current, [step.id]: '' }))
    try {
      await onDecideStep(step, decision, wantsAgain(step, decision))
    } catch (caught) {
      setNotes((current) => ({ ...current, [step.id]: isAlreadyDecided(caught) ? 'Already decided' : errorText(caught, 'The step could not be decided. Try again.') }))
    } finally {
      setDeciding((current) => current.filter((id) => id !== step.id))
    }
  }

  return (
    <CardFrame accent={pending.length ? 'warn' : undefined}>
      <CardHead icon={Network} title={group.title} where={groupSummary(group)} badge={badge} whereLines={2} />
      <View style={styles.children}>
        {group.children.map((child, at) => (
          <ChildRow
            key={at}
            child={child}
            state={states[at]}
            busy={busy || Boolean(child.step && deciding.includes(child.step))}
            deciding={child.step ? deciding.includes(child.step) : false}
            note={child.step ? notes[child.step] : undefined}
            onDecide={decideChild}
            onOpenSession={onOpenSession}
          />
        ))}
      </View>
      <Text style={styles.gather}>{groupGather(group)}</Text>
      <Text style={styles.trail}>{groupTrail(group)}</Text>
      {already ? <NoteLine text="Already decided" icon /> : null}
      {error ? <NoteLine text={error} tone="error" /> : null}
      {pending.length > 1 && !already ? (
        <Buttons>
          <CardButton label="Reject all" busy={all === 'reject'} disabled={busy} onPress={() => void decideAll('reject')} />
          <CardButton label="Approve all" icon={Check} primary grow busy={all === 'approve'} disabled={busy} onPress={() => void decideAll('approve')} />
        </Buttons>
      ) : null}
    </CardFrame>
  )
}

function ChildRow({
  child,
  state,
  busy,
  deciding,
  note,
  onDecide,
  onOpenSession
}: {
  child: GroupChild
  state: ChildState
  busy: boolean
  deciding: boolean
  note?: string
  onDecide: (step: ActionEvent, decision: Decision) => Promise<void>
  onOpenSession?: (machine: string, name: string) => void
}) {
  const step = state.step
  const line = childNote(child, state)
  const prompt = typeof step?.input?.prompt === 'string' ? step.input.prompt : ''
  const rule = step?.rule
  return (
    <View style={styles.child}>
      <View style={styles.childHead}>
        <View style={styles.childId}>
          <Text style={styles.childLabel} numberOfLines={2}>
            {child.label}
          </Text>
          {step ? (
            <Text style={styles.childWhere} numberOfLines={2}>
              {whereLine(step)}
            </Text>
          ) : null}
        </View>
        <Pill badge={state.badge} />
      </View>
      {prompt ? <ClampedText text={prompt} /> : null}
      {line ? <NoteLine text={line.text} tone={line.tone} /> : null}
      {rule ? <Text style={styles.childWhere}>Your rule: {ruleText(rule)}</Text> : null}
      {note ? <NoteLine text={note} tone={note === 'Already decided' ? 'muted' : 'error'} icon={note === 'Already decided'} /> : null}
      {state.key === 'pending' && step ? (
        <Buttons>
          <CardButton label="Reject" disabled={busy} onPress={() => void onDecide(step, 'reject')} />
          <CardButton label="Approve" icon={Check} primary grow disabled={busy} busy={deciding} onPress={() => void onDecide(step, 'approve')} />
        </Buttons>
      ) : null}
      {state.session && state.key !== 'ended' && onOpenSession ? (
        <Buttons>
          <CardButton label="Open" icon={SquareTerminal} onPress={() => onOpenSession(state.session!.machine, state.session!.name)} />
        </Buttons>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  children: { gap: spacing.sm },
  child: {
    gap: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  childHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  childId: { flex: 1, minWidth: 0 },
  childLabel: { fontSize: 15, fontWeight: '600', lineHeight: 20, color: colors.textPrimary },
  childWhere: { fontSize: 12, lineHeight: 17, color: colors.textMuted },
  gather: { fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  trail: { fontSize: 12, lineHeight: 17, color: colors.textMuted }
}))
