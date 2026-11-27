import type { StateView } from '../state/types'
import type { LiveLookup } from './cards/model'
import { CLAUDE_MODELS } from './composer/models'
import type {
  ActionEvent,
  AskAttachment,
  Backend,
  Conversation,
  DispatchEvent,
  RunsOn,
  SavedPrompt,
  TaskMark,
  TrackedSession,
  UserEvent
} from './types'

export const STARTER_LIMIT = 6

const PROMPT_BLOCK = /```prompt[^\n]*\n([\s\S]*?)```/g

type Keyed = Extract<DispatchEvent, { role: 'action' | 'group' }>

const isKeyed = (event: DispatchEvent): event is Keyed => event.role === 'action' || event.role === 'group'

const sameKeyed = (a: DispatchEvent, b: Keyed) => isKeyed(a) && a.role === b.role && a.id === b.id

// The server sends a step or a group again when it changes during a turn, so a streamed one with a
// known id takes the place of the old one instead of drawing a second card.
export function mergeStreamed(events: DispatchEvent[], event: DispatchEvent): DispatchEvent[] {
  if (isKeyed(event)) {
    const at = events.findIndex((e) => sameKeyed(e, event))
    if (at >= 0) return events.map((e, i) => (i === at ? event : e))
  }
  return [...events, event]
}

export function replaceSteps(events: DispatchEvent[], steps: readonly DispatchEvent[]): DispatchEvent[] {
  const byId = new Map<string, Keyed>()
  for (const step of steps) if (isKeyed(step)) byId.set(`${step.role}:${step.id}`, step)
  let changed = false
  const next = events.map((e) => {
    if (!isKeyed(e)) return e
    const fresh = byId.get(`${e.role}:${e.id}`)
    if (!fresh || fresh === e || JSON.stringify(fresh) === JSON.stringify(e)) return e
    changed = true
    return fresh
  })
  return changed ? next : events
}

export function replaceAt(events: DispatchEvent[], index: number, event: DispatchEvent): DispatchEvent[] {
  if (events[index]?.role !== event.role) return events
  return events.map((e, i) => (i === index ? event : e))
}

export const pendingSteps = (events: readonly DispatchEvent[]): ActionEvent[] =>
  events.filter((e): e is ActionEvent => e.role === 'action' && e.status === 'pending')

// Steps of a group are decided in the group card, so the card over the message box leaves them out.
// The all-steps endpoint decides every pending step, grouped or not, so Approve all is offered only
// when no grouped step waits.
export function dockOf(events: readonly DispatchEvent[]): { steps: ActionEvent[]; all: boolean } {
  const pending = pendingSteps(events)
  const steps = pending.filter((step) => !step.group)
  return { steps, all: steps.length > 1 && steps.length === pending.length }
}

export function shownPending(pending: readonly ActionEvent[], chosen: string | null): ActionEvent | null {
  return pending.find((step) => step.id === chosen) ?? pending[0] ?? null
}

export function withdrawnCount(before: readonly DispatchEvent[], after: readonly DispatchEvent[]): number {
  const waiting = new Set(pendingSteps(before).map((step) => step.id))
  return after.filter((e) => e.role === 'action' && e.status === 'withdrawn' && waiting.has(e.id)).length
}

export const withdrawnText = (n: number) =>
  `${n === 1 ? 'The step that waited was' : `The ${n} steps that waited were`} withdrawn because you sent a new message.`

export function waitingText(n: number): string {
  if (n === 1) return '1 step waits for your approval. Sending a new message withdraws it, so Dispatch can propose again.'
  return `${n} steps wait for your approval. Sending a new message withdraws them, so Dispatch can propose again.`
}

export function isOlder(shown: string, updated: string): boolean {
  const a = Date.parse(shown)
  const b = Date.parse(updated)
  return !Number.isNaN(a) && !Number.isNaN(b) && b < a
}

export function hasNews(shown: { updated: string; count: number }, conversation: Pick<Conversation, 'updated' | 'events'>): boolean {
  return conversation.updated !== shown.updated || conversation.events.length > shown.count
}

export function sentEvent(text: string, attachments: readonly AskAttachment[], task?: TaskMark): UserEvent {
  const event: UserEvent = { role: 'user', text }
  if (task) event.task = task
  if (attachments.length) {
    event.attachments = attachments.map((a) => ({ file: '', name: a.name, kind: 'file', size: Math.floor((a.data.length * 3) / 4) }))
  }
  return event
}

export function userCaption(event: UserEvent): string {
  if (event.by === 'yardbell') return 'Sent by Yardbell once the results were in'
  if (event.improve) return `Suggest a better prompt for ${event.improve.name} on ${event.improve.machine}`
  if (event.task) return `Saved prompt ${event.task.name} · version ${event.task.version}`
  return ''
}

export function proposedPrompt(text: string): string {
  const found = [...text.matchAll(PROMPT_BLOCK)]
  return found.length ? found[found.length - 1][1].trim() : ''
}

export type PromptSave = { text: string; from: SavedPrompt }

export function promptSave(events: readonly DispatchEvent[], index: number, prompts: readonly SavedPrompt[]): PromptSave | null {
  const event = events[index]
  if (event?.role !== 'assistant') return null
  let asked: UserEvent | undefined
  for (let i = index - 1; i >= 0 && !asked; i--) {
    const e = events[i]
    if (e.role === 'user') asked = e
  }
  const task = asked?.improve?.task
  if (!task) return null
  const text = proposedPrompt(event.text)
  const from = prompts.find((p) => p.name === task.name && !p.hidden)
  return text && from ? { text, from } : null
}

export function agentLabel(runsOn: RunsOn | null | undefined, name: string): string {
  return runsOn?.agents?.[name]?.label || (name === 'codex' ? 'Codex' : 'Claude Code')
}

export function runsOnText(runsOn: RunsOn | null | undefined, name: string): string {
  const model = runsOn?.agents?.[name]?.model || ''
  const known = CLAUDE_MODELS.find((m) => m.id === model)?.label
  return `${agentLabel(runsOn, name)} (${known || model || 'default model'})`
}

export function backendNote(runsOn: RunsOn | null | undefined, backend: Backend | undefined): string | null {
  if (!runsOn || !backend || backend === runsOn.runs_on) return null
  return `This conversation runs on ${runsOnText(runsOn, backend)}, so it carries on there. New conversations start on ${runsOnText(runsOn, runsOn.runs_on)}. To switch, start a new conversation.`
}

export const introFooter = (runsOn: RunsOn | null | undefined) =>
  `Runs ${runsOnText(runsOn, runsOn?.runs_on ?? 'claude')} with Yardbell's own tools; it starts, reads and answers sessions, never edits files itself. Type / for a saved prompt, @ to name a machine, session or folder.`

export const starters = (prompts: readonly SavedPrompt[]) => prompts.filter((p) => !p.hidden).slice(0, STARTER_LIMIT)

export type TrackedTone = 'blocked' | 'active' | 'stopped' | 'idle' | 'ended'

export type TrackedRow = TrackedSession & { word: string; tone: TrackedTone; live: boolean }

const findSession = (state: StateView | undefined, machine: string, name: string) =>
  state?.sessions.find((s) => s.machine === machine && s.tmux === name && !s.stale)

export function trackedRows(tracked: readonly TrackedSession[], state: StateView | undefined): TrackedRow[] {
  return tracked.map((t) => {
    const s = findSession(state, t.machine, t.name)
    if (!s) return { ...t, word: 'ended', tone: 'ended', live: false }
    if (s.activity === 'blocked') return { ...t, word: 'needs you', tone: 'blocked', live: true }
    if (s.activity === 'active') return { ...t, word: 'working', tone: 'active', live: true }
    if (s.stopped) return { ...t, word: 'stopped on an error', tone: 'stopped', live: true }
    return { ...t, word: 'idle', tone: 'idle', live: true }
  })
}

export function liveLookup(state: StateView | undefined): LiveLookup | undefined {
  if (!state) return undefined
  return (machine, name) => findSession(state, machine, name)?.activity ?? null
}

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

export function settledText(message: string): string {
  const text = message.trim()
  if (!text) return 'Already decided.'
  const sentence = text.charAt(0).toUpperCase() + text.slice(1)
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}
