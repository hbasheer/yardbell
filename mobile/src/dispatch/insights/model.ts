import type { InsightMark, InsightPart, InsightPeriod, Insights, ImproveMark } from '../types'
import { clock } from '../../pipelines/model'

export const SHOWN = 80
export const STATES = ['working', 'waiting', 'idle'] as const
export type InsightState = (typeof STATES)[number]

export const WORDS: Record<InsightState, string> = { working: 'Working', waiting: 'Waiting for you', idle: 'Idle' }

export const MEANS: Record<InsightState, string> = {
  working: 'The agent was busy: thinking, editing files or running commands.',
  waiting: 'It stopped at a question or a permission prompt until you answered.',
  idle: 'Nothing was happening, usually because it had finished and was at its prompt.'
}

const NOW: Record<string, string> = { active: 'working now', blocked: 'waiting for you now', idle: 'idle now' }

export const SUGGEST_HELP = 'Asks Dispatch to read this session and propose a clearer prompt for next time.'

export const times = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function duration(secs: number): string {
  const mins = Math.floor(secs / 60)
  if (mins < 1) return 'under a minute'
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  return mins % 60 ? `${hours} h ${mins % 60} min` : `${hours} h`
}

export const amount = (secs: number) => (!secs ? '0 min' : secs < 60 ? '<1 min' : duration(secs))

export function hour(stamp: string): string {
  const at = new Date(stamp)
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function shares(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0)
  if (!total) return values.map(() => 0)
  const raw = values.map((v) => (v * 100) / total)
  const out = raw.map(Math.floor)
  const left = 100 - out.reduce((a, b) => a + b, 0)
  raw
    .map((v, i) => [v - out[i], i] as const)
    .sort((a, b) => b[0] - a[0])
    .slice(0, left)
    .forEach(([, i]) => out[i]++)
  return out
}

export type Status = { word: string; tone: 'ok' | 'warn' | 'muted' }

export function statusOf(data: Insights): Status {
  if (data.timeline?.ended) return { word: 'Ended', tone: 'muted' }
  if (!data.live) return { word: 'No longer running', tone: 'muted' }
  const now = data.activity ? NOW[data.activity] : undefined
  return { word: now ? `Running, ${now}` : 'Running', tone: data.activity === 'active' ? 'ok' : data.activity === 'blocked' ? 'warn' : 'muted' }
}

export function aboutOf(data: Insights): string {
  const work = data.work
  return work?.title || (data.task ? '' : (work?.first_prompt ?? '')) || ''
}

export function factsOf(data: Insights, now = new Date()): { name: string; value: string }[] {
  const t = data.timeline
  const rows: (readonly [string, string | undefined | false] | null)[] = [
    t ? [t.started ? 'Started' : 'Watched since', clock(t.since, now)] : null,
    t?.ended ? ['Ended', clock(t.ended, now)] : null,
    ['Machine', data.machine],
    t?.folder ? ['Folder', t.folder] : null,
    t?.branch ? ['Branch', t.branch] : null,
    t?.agent ? ['Agent', t.agent] : null
  ]
  return rows.flatMap((row) => (row && row[1] ? [{ name: row[0], value: row[1] }] : []))
}

export function pullWord(pull: NonNullable<Insights['pull']>): string {
  if (pull.state === 'merged') return 'Merged'
  if (pull.state === 'closed') return 'Closed'
  return pull.draft ? 'Draft' : 'Open'
}

export function spentNote(t: NonNullable<Insights['timeline']>, now = new Date()): string {
  const total = STATES.reduce((n, s) => n + (t.totals[s] || 0), 0)
  const all = duration(total)
  const lead = total ? `${all[0].toUpperCase()}${all.slice(1)} in all, from ${clock(t.since, now)} to ${t.ended ? clock(t.ended, now) : 'now'}. ` : ''
  return `${lead}How long the session spent in each state Yardbell tracks.`
}

export type SpentCard = { state: InsightState; amount: string; sub: string }

export function spentCards(t: NonNullable<Insights['timeline']>): { cards: SpentCard[]; tests: { title: string; amount: string; sub: string } } {
  const secs = STATES.map((s) => t.totals[s] || 0)
  const pct = shares(secs)
  const waits = t.periods.filter((p) => p.state === 'waiting').length
  const tests = t.runs.filter((r) => r.ok !== undefined && r.ok !== null)
  const failed = tests.filter((r) => r.ok === false).length
  return {
    cards: STATES.map((state, i) => {
      const share = secs[i] ? `${pct[i] || 'under 1'}% of the time` : ''
      const count = state === 'waiting' ? (waits ? times(waits, 'time') : 'Never waited') : ''
      return { state, amount: amount(secs[i]), sub: [count, share].filter(Boolean).join(', ') }
    }),
    tests: {
      title: 'Test results',
      amount: tests.length ? times(tests.length, 'run') : 'None',
      sub: tests.length ? `${tests.length - failed} passed, ${failed} failed` : ''
    }
  }
}

export type TimelineItem =
  | { key: string; at: string; kind: 'period'; period: InsightPeriod; part?: InsightPart }
  | { key: string; at: string; kind: 'run'; run: InsightMark }
  | { key: string; at: string; kind: 'ended' }

export function timelineOf(data: Insights): { items: TimelineItem[]; told: boolean } {
  const t = data.timeline
  if (!t) return { items: [], told: false }
  const told = Boolean(data.parts?.periods.some((part) => part.did.length))
  const items: TimelineItem[] = [
    ...t.periods.map((period, i): TimelineItem => ({ key: `p${i}`, at: period.from, kind: 'period', period, part: data.parts?.periods[i] })),
    ...t.runs.filter((run) => !(told && run.kind === 'tool')).map((run, i): TimelineItem => ({ key: `r${i}`, at: run.at, kind: 'run', run }))
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  if (t.ended) items.push({ key: 'ended', at: t.ended, kind: 'ended' })
  return { items, told }
}

export const partSaid = (part?: InsightPart) =>
  Boolean(part && (part.asked?.length || part.question || part.stopped_at || part.summary || part.said))

export const partLines = (part: InsightPart): { who: string; text: string; warn?: boolean }[] => [
  ...(part.asked ?? []).map((text) => ({ who: 'You said', text })),
  ...(part.question ? [{ who: 'It asked', text: part.question, warn: true }] : []),
  ...(part.stopped_at ? [{ who: 'Stopped at', text: part.stopped_at, warn: true }] : []),
  ...(part.summary ? [{ who: 'Did', text: part.summary }] : []),
  ...(part.said ? [{ who: 'It said', text: part.said }] : [])
]

export const stepTotal = (part: InsightPart) => part.did.length + (part.more || 0)

export const timelineNote = (data: Insights, told: boolean): string => {
  const t = data.timeline
  const lead = told
    ? "What happened in each stretch of working, waiting and idle, from this session's transcript, with each test run"
    : 'Each change between working, waiting and idle with how long it lasted, and each tool call and test run Yardbell saw'
  const pull = t?.runs.some((r) => r.kind === 'pull') ? ', and what happened to its pull request or merge request' : ''
  const warn = [
    data.work?.shared ? 'Another session runs in this folder, so the detail may be from that session.' : '',
    data.work?.partial ? 'This is a long session, so older stretches may have no detail.' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return `${lead}${pull}, oldest first.${warn ? ` ${warn}` : ''}`
}

export const fromLine = (from: NonNullable<Insights['from']>) =>
  `From the task ${from.name}, version ${from.version}${from.current !== from.version ? `. It is at version ${from.current} now` : ''}.`

export function improveMark(data: Pick<Insights, 'machine' | 'name' | 'from'>): ImproveMark {
  return { machine: data.machine, name: data.name, ...(data.from ? { task: { name: data.from.name, version: data.from.version } } : {}) }
}

export type Suggestion = { text: string; improve: ImproveMark }

export const suggestionOf = (data: Insights): Suggestion => ({ text: data.suggest, improve: improveMark(data) })

export const suggestHref = (serverId: string, suggestion: Suggestion) =>
  `/dispatch/${encodeURIComponent(serverId)}/new?suggest=${encodeURIComponent(JSON.stringify(suggestion))}`

export function parseSuggestion(value: string | undefined): Suggestion | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<Suggestion>
    const mark = parsed.improve
    if (typeof parsed.text !== 'string' || !parsed.text.trim() || !mark || typeof mark.machine !== 'string' || typeof mark.name !== 'string') return null
    const task = mark.task && typeof mark.task.name === 'string' && typeof mark.task.version === 'number' ? { name: mark.task.name, version: mark.task.version } : undefined
    return { text: parsed.text, improve: { machine: mark.machine, name: mark.name, ...(task ? { task } : {}) } }
  } catch {
    return null
  }
}

export const insightsIntro = (machine: string, name: string, loaded: boolean) =>
  loaded ? `What Yardbell saw of this session on ${machine} while it watched it.` : `Reading ${name} on ${machine}…`

export const EMPTY_TITLE = 'Nothing recorded yet'
export const emptyBody = (machine: string) =>
  `Yardbell builds this timeline from its regular checks of ${machine}. It has not checked this session since it appeared, so the first entries come with the next check. Open Insights again in a moment.`
