import { clock } from '../../steps/model'
import type {
  ActionEvent,
  Finding,
  GroupChild,
  GroupEvent,
  PullEvent,
  PullRef,
  ResultChild,
  ResultsEvent,
  ReviewEvent,
  ReviewOutcome,
  SessionEvent,
  Trigger
} from '../types'

export type Tone = 'ok' | 'warn' | 'error' | 'muted'

export type Badge = { label: string; tone: Tone }

export const SCREEN_TAIL = 4

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function timeOf(stamp: string | undefined): string {
  const at = new Date(stamp ?? '')
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export const short = (path: string | undefined) => String(path ?? '').replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, '~')

export const folderOf = (path: string | undefined) => {
  const clean = String(path ?? '').replace(/\/+$/, '')
  return clean.split('/').pop() || clean
}

export const optionLabel = (label: string): string =>
  String(label)
    .split(/ {3}|[─-╿]/)[0]
    .trim() || label

// Rules drawn across the terminal carry no text, and the agent's own left margin only pushes lines right.
export function readable(screen: string): string {
  const lines = String(screen)
    .split('\n')
    .filter((l) => !/^[\s─-╿]+$/.test(l) || !l.trim())
    .map((l) => l.replace(/\s*[│┃]?\s*$/, ''))
    .filter((l, i, all) => l.trim() || (i > 0 && all[i - 1].trim()))
  const indents = lines.filter((l) => l.trim()).map((l) => (l.match(/^ */) as RegExpMatchArray)[0].length)
  const cut = indents.length ? Math.min(...indents) : 0
  return lines
    .map((l) => l.slice(cut))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
}

export function screenView(screen: string, open: boolean): { text: string; total: number; long: boolean } {
  const lines = readable(screen).split('\n')
  const long = lines.length > SCREEN_TAIL
  return { text: (long && !open ? lines.slice(-SCREEN_TAIL) : lines).join('\n'), total: lines.length, long }
}

export function serverTime(stamp: string | undefined): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(stamp ?? '')
  if (!m) return ''
  const day = new Date(`${m[1]}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
  return `${day}, ${m[2]}`
}

export function minutes(n: number): string {
  if (n % 60 === 0 && n >= 60) return plural(n / 60, 'hour', 'hours')
  return `${n} min`
}

export function toolTarget(input: unknown): string {
  const data = (input ?? {}) as Record<string, unknown>
  const where = [data.machine, data.folder || data.path, data.branch].filter((v): v is string => typeof v === 'string' && v !== '')
  return where.length ? where.join(' · ') : ''
}

export const pullRef = (pull: PullRef | undefined) => `${pull?.forge === 'gitlab' ? '!' : '#'}${pull?.number ?? ''}`
export const pullNoun = (pull: PullRef | undefined) => (pull?.forge === 'gitlab' ? 'Merge request' : 'Pull request')

const SESSION_STATES: Record<string, Badge> = {
  blocked: { label: 'Waiting for you', tone: 'warn' },
  idle: { label: 'Stopped', tone: 'muted' },
  ended: { label: 'Ended', tone: 'muted' }
}

export function sessionBadge(e: SessionEvent): Badge {
  if (e.answer) return { label: 'Answered', tone: 'ok' }
  return SESSION_STATES[e.state] ?? { label: e.state, tone: 'muted' }
}

export const canReview = (e: SessionEvent) => (e.state === 'idle' || e.state === 'ended') && !e.review

export function answeredLine(e: SessionEvent): string {
  if (!e.answer) return ''
  const at = e.answer.at ? ` at ${timeOf(e.answer.at)}` : ''
  return `You answered ${optionLabel(e.answer.label)}${at}`
}

export const SCAN_KINDS: { kind: 'dead_code' | 'test_gaps' | 'security'; label: string; hint: string }[] = [
  { kind: 'dead_code', label: 'Dead code scan', hint: 'Unused functions, modules, routes, assets and config' },
  { kind: 'test_gaps', label: 'Test gap scan', hint: 'Important code without tests, and runs the tests' },
  { kind: 'security', label: 'Security scan', hint: 'Secrets, injection, unsafe input, missing auth checks and advisories' }
]

export const SCAN_TITLES: Record<string, string> = Object.fromEntries(SCAN_KINDS.map((s) => [s.kind, s.label]))

export function pullKind(e: PullEvent): Badge {
  if (e.kind === 'ci') return { label: 'CI failed', tone: 'error' }
  if (e.kind === 'conflict') return { label: 'Merge conflicts', tone: 'warn' }
  if (e.kind === 'limit') return { label: 'Limit reset', tone: 'warn' }
  return { label: (e.notes ?? []).some((n) => n.kind === 'changes_requested') ? 'Changes requested' : 'New comments', tone: 'warn' }
}

export function pullTitle(e: PullEvent): { ref: string; text: string } {
  if (e.kind === 'limit') return { ref: '', text: e.folder || e.name }
  return { ref: pullRef(e.pull), text: e.pull?.title ?? '' }
}

export function noteSaid(note: { kind?: string; place?: string }): string {
  if (note.kind === 'changes_requested') return 'requested changes'
  if (note.kind === 'inline' && note.place) return `on ${note.place}`
  if (note.kind === 'review') return 'reviewed'
  return 'commented'
}

export function firstError(log: string): string {
  const lines = String(log)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.find((l) => /\b(error|fail(ed|ure)?|panicked)\b|[✗✕]/i.test(l)) ?? lines[0] ?? ''
}

export const isLongText = (text: string, chars: number) => text.length > chars || text.split('\n').length > 3

export function conflictLine(e: PullEvent): string {
  const base = e.pull?.base ? e.pull.base : 'its base branch'
  return `${pullNoun(e.pull)} ${pullRef(e.pull)} can no longer merge into ${base} without conflicts.`
}

export function limitLine(e: PullEvent): string {
  const at = timeOf(e.resets)
  return `It stopped at its usage limit${e.error ? `: ${e.error}` : ''}. The limit reset${at ? ` at ${at}` : ''}, so it can go on.`
}

export type SentNote = { text: string; again: boolean; tone: Tone }

export function sentNote(e: PullEvent, step: ActionEvent | null | undefined, sending: boolean): SentNote | null {
  if (sending) return { text: 'Sending…', again: false, tone: 'muted' }
  if (!e.sent) return null
  if (!step) return { text: 'Sent to the session.', again: false, tone: 'ok' }
  if (step.status === 'pending') return { text: 'Waiting for your approval below.', again: false, tone: 'warn' }
  if (step.status === 'rejected' || step.status === 'withdrawn') return { text: '', again: true, tone: 'muted' }
  if (step.result && step.result.ok === false) return { text: `Not sent: ${step.result.text}`, again: false, tone: 'error' }
  const at = step.result?.at || step.decided
  return { text: `Sent${at ? ` at ${timeOf(at)}` : ''}.`, again: false, tone: 'ok' }
}

export type LiveActivity = 'active' | 'blocked' | 'idle'

export type LiveLookup = (machine: string, name: string) => LiveActivity | null

export type ChildKey = 'refused' | 'lost' | 'starting' | 'pending' | 'rejected' | 'withdrawn' | 'failed' | 'working' | 'blocked' | 'idle' | 'ended' | 'started'

export type ChildState = { key: ChildKey; badge: Badge; step?: ActionEvent; session?: { machine: string; name: string } }

export function childState(child: GroupChild, step: ActionEvent | undefined, deciding: boolean, live?: LiveLookup): ChildState {
  if (child.refused) return { key: 'refused', badge: { label: 'Refused', tone: 'error' } }
  if (!step) return { key: 'lost', badge: { label: 'Not started', tone: 'muted' } }
  if (deciding || ((step.status === 'approved' || step.status === 'edited' || step.status === 'auto') && !step.result)) {
    return { key: 'starting', badge: { label: 'Starting', tone: 'muted' }, step }
  }
  if (step.status === 'pending') return { key: 'pending', badge: { label: 'Waiting for you', tone: 'warn' }, step }
  if (step.status === 'rejected') return { key: 'rejected', badge: { label: 'Rejected', tone: 'muted' }, step }
  if (step.status === 'withdrawn') return { key: 'withdrawn', badge: { label: 'Withdrawn', tone: 'muted' }, step }
  if (step.result && !step.result.ok) return { key: 'failed', badge: { label: 'Failed to start', tone: 'error' }, step }
  const session = step.result?.session
  const seen = session && live ? live(session.machine, session.name) : null
  const state = seen ? (seen === 'active' ? 'working' : seen) : child.state || 'started'
  const badges: Record<string, Badge> = {
    working: { label: 'Working', tone: 'muted' },
    blocked: { label: 'Needs you', tone: 'warn' },
    idle: child.worked ? { label: 'Done', tone: 'ok' } : { label: 'Idle', tone: 'muted' },
    ended: { label: 'Ended', tone: 'muted' }
  }
  return { key: state as ChildKey, badge: badges[state] ?? { label: 'Started', tone: 'muted' }, step, session }
}

export function childNote(child: GroupChild, st: ChildState): { text: string; tone: Tone } | null {
  if (child.refused) return { text: `Not started: ${child.refused}.`, tone: 'error' }
  if (st.key === 'failed') return { text: st.step?.result?.text ?? 'It could not start.', tone: 'error' }
  if (st.session) return { text: `${st.key === 'ended' ? 'Was' : 'Running as'} ${st.session.name} on ${st.session.machine}`, tone: 'muted' }
  return null
}

export function groupBadge(group: GroupEvent, states: ChildState[]): Badge {
  const waiting = states.filter((s) => s.key === 'pending').length
  if (waiting) return { label: waiting === states.length ? 'Waiting for you' : `${waiting} wait for you`, tone: 'warn' }
  if (group.status === 'gathered') return { label: 'Results below', tone: 'ok' }
  if (group.status === 'dropped') return { label: 'Nothing started', tone: 'muted' }
  if (group.status === 'gathering') return { label: 'Gathering', tone: 'muted' }
  const started = states.filter((s) => s.session)
  const done = started.filter((s) => s.key === 'ended' || s.badge.tone === 'ok').length
  if (!started.length) return { label: 'Starting', tone: 'muted' }
  return { label: `${done} of ${started.length} done`, tone: 'muted' }
}

export function groupSummary(group: GroupEvent): string {
  return `${plural(group.children.length, 'session', 'sessions')} · gathered when all are done, or after ${minutes(group.minutes || 60)}`
}

export function groupGather(group: GroupEvent): string {
  const then = typeof group.gather === 'string' ? group.gather : ''
  if (!then) return 'Dispatch hears the results with your next message.'
  if (group.follow) return `Then Dispatch acts on the results: ${then}.`
  return `Dispatch hears the results with your next message, then: ${then}.`
}

export function groupTrail(group: GroupEvent): string {
  const parts = [`Proposed by Dispatch ${clock(group.at)}`]
  if (group.started) parts.push(`Running since ${clock(group.started)}`)
  if (group.gathered) parts.push(`Gathered ${clock(group.gathered)}`)
  return parts.join(' · ')
}

export const pendingSteps = (states: ChildState[]): ActionEvent[] => states.flatMap((s) => (s.key === 'pending' && s.step ? [s.step] : []))

export function failedStarts(decided: ActionEvent[]): number {
  return decided.filter((s) => s.result && !s.result.ok).length
}

export function failedWords(decided: ActionEvent[]): string {
  const failed = failedStarts(decided)
  return failed ? `${failed} of ${plural(decided.length, 'child', 'children')} failed to start. Each row says why.` : ''
}

const RESULT: Record<string, Badge> = {
  done: { label: 'Done', tone: 'ok' },
  partial: { label: 'Partly done', tone: 'warn' },
  failed: { label: 'Failed', tone: 'error' }
}

export function resultBadge(c: ResultChild): Badge {
  if (!c.started) return { label: 'Did not start', tone: 'muted' }
  if (c.result) return RESULT[c.result.status] ?? { label: c.result.status, tone: 'muted' }
  if (c.state === 'needs input') return { label: 'Needs you', tone: 'warn' }
  if (c.state === 'still working') return { label: 'Still working', tone: 'muted' }
  return { label: 'No result', tone: 'muted' }
}

export function resultsHead(e: ResultsEvent): { title: string; summary: string; badge: Badge; timedOut: boolean } {
  const started = e.children.filter((c) => c.started)
  const finished = started.filter((c) => c.result || c.state === 'finished' || c.state === 'ended').length
  const timedOut = e.why === 'timeout'
  const all = ({ 1: 'The session is done', 2: 'Both sessions are done' } as Record<number, string>)[started.length] ?? `All ${started.length} sessions are done`
  return {
    title: `Results of ${e.title}`,
    summary: timedOut ? `Gathered after ${minutes(e.minutes || 60)}, ${finished} of ${plural(started.length, 'session', 'sessions')} finished` : all,
    badge: timedOut ? { label: 'Timed out', tone: 'warn' } : { label: 'All done', tone: 'ok' },
    timedOut
  }
}

export function resultsTrail(e: ResultsEvent): string {
  const then = e.follow && typeof e.gather === 'string' ? `Dispatch was asked to act on these results: ${e.gather}` : 'Dispatch hears these results with your next message'
  return `Gathered ${clock(e.at)} · ${then}.`
}

export const SEVERITY: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low' }
const SEVERITY_ORDER = ['high', 'medium', 'low']

export const findingWords = (n: number) => plural(n, 'finding', 'findings')

export type FindingGroup = { severity: string; label: string; items: { finding: Finding; index: number }[] }

export function findingGroups(findings: Finding[]): FindingGroup[] {
  const all = findings.map((finding, index) => ({ finding, index }))
  return [...SEVERITY_ORDER, '']
    .map((severity) => ({
      severity,
      label: SEVERITY[severity] ?? 'Other',
      items: all.filter(({ finding }) => (severity ? finding.severity === severity : !SEVERITY_ORDER.includes(finding.severity)))
    }))
    .filter((group) => group.items.length)
}

export function defaultPicked(findings: Finding[]): number[] {
  return findings.flatMap((f, i) => (f.severity === 'low' ? [] : [i]))
}

export function pickedOf(e: ReviewEvent, chosen: number[] | undefined): number[] {
  if (e.outcome) return e.outcome.findings ?? []
  return chosen ?? defaultPicked(e.findings ?? [])
}

export const isScan = (e: ReviewEvent) => Boolean(e.of?.scan && SCAN_TITLES[e.of.scan])

export function reviewHead(e: ReviewEvent): { title: string; where: string; badge: Badge } {
  const of = e.of ?? {}
  if (isScan(e)) {
    const n = (e.findings ?? []).length
    const clean = e.verdict === 'clean' || !n
    return {
      title: `${SCAN_TITLES[of.scan as string]} of ${folderOf(of.path)}`,
      where: `by ${e.name} on ${e.machine}${of.branch ? ` · ${of.branch}` : ''}`,
      badge: clean ? { label: e.verdict === 'clean' ? 'Clean' : 'Issues found', tone: 'ok' } : { label: `${n} ${n === 1 ? 'issue' : 'issues'} found`, tone: 'warn' }
    }
  }
  const ready = e.verdict === 'ready'
  return {
    title: `Review of ${of.pull ? `${pullRef(of.pull)} · ` : ''}${of.branch || of.name || e.name}`,
    where: `by ${e.name} on ${e.machine}${of.path ? ` · ${folderOf(of.path)}` : ''}`,
    badge: ready ? { label: 'Ready', tone: 'ok' } : { label: 'Changes needed', tone: 'warn' }
  }
}

export function decidedWords(e: ReviewEvent, outcome: ReviewOutcome): string {
  const n = findingWords(outcome.findings?.length ?? 0)
  if (outcome.decision === 'sent') return `Sent ${n} to ${outcome.to} ${clock(outcome.at)}`
  if (outcome.decision === 'started') return `Asked for a new session to fix ${n} ${clock(outcome.at)}`
  return `Dismissed ${clock(outcome.at)}`
}

export type SettleAction = { label: string; body: { decision: 'send'; findings: number[]; to?: string } | { decision: 'start'; findings: number[] } }

export function settleAction(e: ReviewEvent, picked: number[], target: string): SettleAction {
  const findings = [...picked].sort((a, b) => a - b)
  if (isScan(e) && !target) return { label: `Fix ${picked.length} in a new session`, body: { decision: 'start', findings } }
  return { label: `Send ${findingWords(picked.length)}`, body: { decision: 'send', findings, ...(target ? { to: target } : {}) } }
}

export function toastWords(e: ReviewEvent, picked: number[], action: SettleAction): string {
  const n = findingWords(picked.length)
  if (action.body.decision === 'start') return `A new session for ${n} waits below for you to start it`
  return `Sent ${n} to ${action.body.to || e.of?.name}`
}

export const isLate = (t: Trigger): boolean => Boolean(t.slot && t.at) && Date.parse(t.at as string) - Date.parse(t.slot as string) >= 120000

export type TriggerStanding = { known: boolean; enabled: boolean } | 'deleted' | null

export function triggerLine(t: Trigger, standing: TriggerStanding): string {
  const parts: string[] = []
  if (t.task) parts.push(`Task ${t.task}${t.version ? `, version ${t.version}` : ''}`)
  if (t.what) parts.push(t.what)
  const late = isLate(t) ? `, late for ${(/T(\d{2}:\d{2})/.exec(t.slot ?? '') ?? [])[1] ?? ''}` : ''
  const when = serverTime(t.at)
  if (when) parts.push(`${when}${late}`)
  if (standing === 'deleted') parts.push('The trigger was deleted')
  else if (standing && !standing.enabled) parts.push('The trigger is off')
  return parts.join(' · ')
}

export function triggerStanding(list: { triggers: { trigger: { name: string; enabled: boolean } }[] } | null, name: string): TriggerStanding {
  if (!list) return null
  const found = list.triggers.find((v) => v.trigger.name === name)
  return found ? { known: true, enabled: found.trigger.enabled } : 'deleted'
}

export const triggerToast = (name: string, enabled: boolean) =>
  enabled ? `The trigger ${name} is on.` : `The trigger ${name} is off. It starts nothing until you turn it on here or in Settings.`
