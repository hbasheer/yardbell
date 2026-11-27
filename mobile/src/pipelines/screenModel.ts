import type { DiagramRef, ListedPipeline, RunStart, TranscriptItem } from './api'
import {
  ANSWERABLE,
  ENDED,
  WORDS,
  ago,
  asksForYou,
  clock,
  runLabel,
  splitRunItems,
  staying,
  stateWord,
  stepName,
  tokenCount,
  took,
  type BriefRun,
  type Definition,
  type Run,
  type Step
} from './model'

export type RunTone = 'wait' | 'ok' | 'run' | 'off'

export const runTone = (run: Pick<BriefRun, 'state' | 'held'>): RunTone =>
  asksForYou(run) ? 'wait' : run.state === 'done' ? 'ok' : ENDED.includes(run.state) ? 'off' : 'run'

export const RUN_WORD: Record<RunTone, string> = { wait: 'Waiting for you', ok: 'Done', run: 'Running', off: 'Ended' }

export const isEnded = (run: Pick<BriefRun, 'state'>) => ENDED.includes(run.state)

export const LIST_POLL_MS = 10_000

export function runPollMs(run?: Pick<BriefRun, 'state'>): number {
  if (!run || run.state === 'running' || run.state === 'queued') return 4_000
  if (run.state === 'waiting') return 8_000
  return 30_000
}

export function sortPipelines(list: ListedPipeline[]): ListedPipeline[] {
  const waits = (p: ListedPipeline) => Number((p.runs.waiting || 0) > 0)
  return [...list].sort((a, b) => waits(b) - waits(a) || a.definition.name.localeCompare(b.definition.name))
}

export type TriggerIcon = 'schedule' | 'manual' | 'webhook' | 'pull' | 'ticket'

export function triggerIcon(kind?: string): TriggerIcon {
  if (!kind || kind === 'manual') return 'manual'
  if (kind === 'schedule') return 'schedule'
  if (kind === 'webhook') return 'webhook'
  if (kind === 'github_review' || kind === 'gitlab_reviewer') return 'pull'
  return 'ticket'
}

export const waitingRuns = <T extends Pick<BriefRun, 'state' | 'held'>>(runs: T[]): T[] => runs.filter(asksForYou)

export const briefLabel = (run: Pick<BriefRun, 'subject'>) => (run.subject?.ticket || run.subject?.pr ? runLabel({ subject: run.subject, started: '' }) : 'Run with no ticket or link')

export const waitingReason = (run: Pick<BriefRun, 'waiting' | 'held'>) => run.waiting?.reason || run.held?.reason || 'Waiting'

export const waitingAge = (run: Pick<BriefRun, 'held' | 'step_since'>, now = Date.now()) => ago(run.held?.since || run.step_since, now)

export function markRun<T extends Pick<BriefRun, 'state'>>(runs: T[]): T | null {
  return runs.find((run) => !isEnded(run)) ?? runs[0] ?? null
}

export function nodeOrder(d: Definition): Step[] {
  const path: Step[] = []
  let id: string | undefined = d.start
  while (id) {
    const step = d.steps.find((s) => s.id === id)
    if (!step || path.includes(step)) break
    path.push(step)
    id = step.next.pass
  }
  return [...path, ...d.steps.filter((s) => !path.includes(s))]
}

export function nextWords(d: Definition, step: Step): string[] {
  const words: string[] = []
  if (step.next.pass) words.push(`On pass, ${stepName(d, step.next.pass)}`)
  if (step.next.fail) words.push(`On fail, ${stepName(d, step.next.fail)}`)
  if (step.next.needs_you) words.push(`When it needs you, ${stepName(d, step.next.needs_you)}`)
  return words
}

export type NeedButton = { action: 'retry' | 'accept-tool'; label: string }

export type NeedBox = {
  title: string
  reason: string
  questions: string[]
  help: string | null
  raise: { placeholder: string } | null
  screen: string
  commandNote: string | null
  answerable: boolean
  primary: NeedButton
  fail: boolean
  pass: boolean
}

const NEED_HELP: Record<string, string> = {
  no_result:
    'The agent went quiet and Yardbell could not read a result from it. Show the terminal to see what it did, then retry the step, continue on pass or fail, or answer it.',
  unchanged:
    'Yardbell did not start this step and did not reuse its last verdict. Run it again to read the same code, or continue on pass or fail to take that line yourself.',
  token_limit:
    'This step uses tokens and was not started. Raise the limit to go on, or start this one step and the run waits again after it.',
  token_unknown: 'Starting it anyway leaves its use out of the total, and the run does not ask again.'
}

export function needBox(run: Run, d: Definition): NeedBox {
  const w = run.waiting || { kind: '', step: '' }
  const name = stepName(d, w.step)
  const reason = w.reason || ''
  const tokenWait = w.kind === 'token_limit' || w.kind === 'token_unknown'
  const step = d.steps.find((s) => s.id === w.step)
  const command = step?.kind === 'command'
  const ran = run.steps?.[w.step]?.ran
  const didRun = Boolean(ran) && ran!.command === step?.command && step?.approved === step?.command
  let commandNote: string | null = null
  if (command && !didRun) commandNote = 'This command has not run in this attempt, so the step cannot continue on pass.'
  else if (command && didRun && !ran!.passed) commandNote = 'This command failed. If you continue on pass, the run records that you overrode it.'
  const primary: NeedButton =
    w.kind === 'tool_changed'
      ? { action: 'accept-tool', label: 'Accept and run' }
      : { action: 'retry', label: tokenWait ? 'Start this step anyway' : w.kind === 'unchanged' ? 'Run it again' : 'Retry step' }
  return {
    title: reason.startsWith(name) ? reason : name,
    reason: reason.startsWith(name) ? '' : reason,
    questions: w.kind === 'questions' ? (run.questions || []).filter((q) => !q.answer).map((q) => q.asked) : [],
    help: NEED_HELP[w.kind] ?? null,
    raise: w.kind === 'token_limit' ? { placeholder: tokenCount((run.tokens_used || 0) * 2 || 1000) } : null,
    screen: w.screen || '',
    commandNote,
    answerable: ANSWERABLE.includes(w.kind),
    primary,
    fail: !tokenWait,
    pass: !tokenWait && !(command && !didRun)
  }
}

export function parseLimit(text: string): number | null {
  const n = Number(text.replace(/[,\s_]/g, ''))
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null
}

export type TokenBar = {
  total: string
  limit: string
  pct: number | null
  tone: 'ok' | 'warn' | 'over'
  pastLimit: boolean
  unknown: string[]
  cache: string | null
}

export function tokenBar(run: Pick<Run, 'state' | 'tokens' | 'tokens_used' | 'tokens_from_cache'>): TokenBar | null {
  const t = run.tokens || {}
  const used = run.tokens_used || 0
  const unknown = Object.values(t.unknown || {})
  if (!used && !unknown.length && !t.limit) return null
  const passed = Boolean(t.limit && used >= t.limit)
  const pct = t.limit ? Math.min(100, (used * 100) / t.limit) : null
  return {
    total: used ? `${unknown.length ? 'At least ' : ''}${tokenCount(used)} tokens` : unknown.length ? 'Not known' : '0 tokens',
    limit: t.limit ? `Limit ${tokenCount(t.limit)}` : 'No limit',
    pct,
    tone: passed ? 'over' : (pct ?? 0) >= 80 ? 'warn' : 'ok',
    pastLimit: passed && ['running', 'queued'].includes(run.state),
    unknown: unknown.map((why) => `${why}, so the real total may be higher.`),
    cache: run.tokens_from_cache ? `${tokenCount(run.tokens_from_cache)} more were read from cache and are not counted.` : null
  }
}

export function heldText(run: Pick<Run, 'held'>): { reason: string; help: string | null; plain: boolean } | null {
  const h = run.held
  if (!h) return null
  if (h.kind === 'spacing') return { reason: h.reason || '', help: null, plain: true }
  return {
    reason: h.reason || '',
    help: h.told
      ? `Held since ${clock(h.since)}. It still starts by itself. To start it sooner, free memory on ${h.machine} or raise the limit in the Pipelines settings, or stop this run.`
      : null,
    plain: false
  }
}

export const startedLine = (run: Run, d: Definition) =>
  `Started ${clock(run.started)} by ${run.started_by === 'you' ? 'you' : 'a trigger'} · ${stateWord(run, d)}`

export type RunChip =
  | { kind: 'ticket' | 'pr' | 'draft'; label: string; url: string }
  | { kind: 'conversation'; label: string; id: string }
  | { kind: 'place'; label: string }

export function runChips(run: Run): RunChip[] {
  const s = run.subject || {}
  const chips: RunChip[] = []
  if (s.ticket?.url) chips.push({ kind: 'ticket', label: s.ticket.id, url: s.ticket.url })
  if (s.pr) chips.push({ kind: 'pr', label: s.pr.forge === 'gitlab' ? `!${s.pr.number}` : `#${s.pr.number}`, url: s.pr.url })
  if (run.pull) chips.push({ kind: 'draft', label: `Draft #${run.pull.number}`, url: run.pull.url })
  if (run.conversation) chips.push({ kind: 'conversation', label: 'Conversation', id: run.conversation })
  if (run.place?.machine) chips.push({ kind: 'place', label: [run.place.machine, run.place.branch].filter(Boolean).join(' · ') })
  return chips
}

export const reachedSteps = (run: Pick<Run, 'steps'>, d: Definition): Step[] => d.steps.filter((s) => run.steps?.[s.id])

export function reportParts(text: string): { head: string; rest: string } {
  const lines = text.trim().split('\n')
  if (lines.length <= 3) return { head: text.trim(), rest: '' }
  return { head: lines.slice(0, 2).join('\n'), rest: lines.slice(2).join('\n') }
}

export type HistoryTone = 'fail' | 'needs' | 'ok' | 'step' | 'run'

export type HistoryRow = { at: string; tone: HistoryTone; name: string; word: string; note: string }

type Entry = NonNullable<Run['history']>[number]

function entryWord(run: Pick<Run, 'state'>, e: Entry, last: boolean): string {
  if (e.outcome) return WORDS[e.outcome]
  if (last && !ENDED.includes(run.state)) return run.state === 'waiting' ? 'waiting for you' : run.state
  return 'ended without a result'
}

export function historyRows(run: Pick<Run, 'state' | 'history'>, d: Definition, only?: string): HistoryRow[] {
  const all = run.history || []
  return all.flatMap((e, i) => {
    if (only && e.step !== only) return []
    const tone: HistoryTone =
      e.outcome === 'fail' ? 'fail' : e.outcome === 'needs_you' ? 'needs' : e.outcome ? 'ok' : e.step ? 'step' : 'run'
    if (!e.step) return [{ at: e.at, tone, name: 'Run', word: e.note || 'started', note: '' }]
    return [{ at: e.at, tone, name: only ? '' : stepName(d, e.step), word: entryWord(run, e, i === all.length - 1), note: e.note || '' }]
  })
}

export type StepFact = { name: string; value: string; mono?: boolean }

export function stepFacts(run: Run, step: Step, now: { note: string; cls: string }): StepFact[] {
  const st = run.steps?.[step.id]
  if (!st) return []
  const again = (st.runs || 0) > 1
  const outcome = st.outcome ? WORDS[st.outcome] : now.cls === 'now' || now.cls === 'waiting' ? now.note : 'No result'
  const facts: StepFact[] = [
    { name: 'Outcome', value: outcome },
    { name: again ? 'Last started' : 'Started', value: clock(st.started) },
    { name: again ? 'Last ended' : 'Ended', value: clock(st.ended) },
    { name: 'Took', value: took(st.started, st.ended) },
    { name: 'Ran', value: st.runs === 1 ? 'Once' : st.runs ? `${st.runs} times` : '' },
    { name: 'Machine', value: st.machine || '' },
    { name: 'Folder', value: st.path || '', mono: true },
    { name: 'Session', value: st.session || '', mono: true }
  ]
  return facts.filter((f) => f.value)
}

export type TranscriptPart = { kind: 'tools'; list: TranscriptItem[] } | TranscriptItem

export function transcriptParts(items: TranscriptItem[]): TranscriptPart[] {
  const parts: TranscriptPart[] = []
  for (const item of items) {
    const prev = parts.at(-1)
    if (item.kind === 'tool' && prev?.kind === 'tools') prev.list.push(item)
    else parts.push(item.kind === 'tool' ? { kind: 'tools', list: [item] } : item)
  }
  return parts
}

export const PROMPT_FOLD = 280

export type Confirm = { title: string; body: string; confirm: string }

export const deleteRunConfirm = (run: Run): Confirm => ({
  title: 'Delete this run?',
  body: `Its record goes: the step results, reports and history shown here.\n${staying([run])}`,
  confirm: 'Delete'
})

export function clearEndedConfirm(ended: Run[]): Confirm {
  const n = ended.length
  return {
    title: `Delete ${n} finished ${n === 1 ? 'run' : 'runs'}?`,
    body: `${n === 1 ? 'Its record goes' : 'Their records go'}: the step results, reports and history. Runs still queued, running or waiting are kept.\n${staying(ended)}`,
    confirm: 'Delete'
  }
}

export const clearedWord = (n: number) => `Deleted ${n} finished ${n === 1 ? 'run' : 'runs'}`

export const stopSessionConfirm = (t: { name: string; current?: boolean }): Confirm => ({
  title: `Stop ${t.name}?`,
  body: t.current ? 'The agent in it stops. The step then waits for you.' : 'The agent in it stops.',
  confirm: 'Stop session'
})

export function dropConfirm(run: Pick<Run, 'state'>): Confirm {
  const waiting = run.state === 'waiting'
  return {
    title: waiting ? 'Drop this run?' : 'Stop this run?',
    body: 'It ends here and does not go on to its next step. Its record stays, so you can still read it.',
    confirm: waiting ? 'Drop' : 'Stop this run'
  }
}

export type RunNowForm =
  | { kind: 'none'; message: string }
  | { kind: 'items'; label: string; placeholder: string; help: string; required: boolean; diagrams: boolean; tickets: boolean }

export function runNowForm(triggerKind: string): RunNowForm {
  if (triggerKind === 'schedule') return { kind: 'none', message: 'Starts one run now, as its schedule would.' }
  if (triggerKind === 'webhook') return { kind: 'none', message: 'Starts one run with no item.' }
  if (triggerKind === 'connector') return { kind: 'items', label: 'Item ids or links', placeholder: 'abc123', help: 'One run each.', required: true, diagrams: false, tickets: false }
  if (triggerKind === 'manual')
    return {
      kind: 'items',
      label: 'Ticket ids or links (optional)',
      placeholder: 'COM-1234 COM-1240',
      help: 'One run each, or leave it empty for one run with no ticket.',
      required: false,
      diagrams: true,
      tickets: false
    }
  if (triggerKind === 'linear')
    return { kind: 'items', label: 'Ticket ids', placeholder: 'COM-1234 COM-1240', help: 'One run each. Ticket ids and links can be mixed.', required: true, diagrams: false, tickets: true }
  return {
    kind: 'items',
    label: 'Merge or pull request links',
    placeholder: 'https://gitlab.example.com/group/app/-/merge_requests/87',
    help: 'One run each. Ticket ids and links can be mixed.',
    required: true,
    diagrams: false,
    tickets: false
  }
}

export const canStart = (form: RunNowForm, text: string) => form.kind === 'none' || !form.required || text.trim() !== ''

export function runStartBody(triggerKind: string, text: string, diagram: DiagramRef | null): RunStart {
  if (triggerKind === 'schedule') return {}
  const body: RunStart = splitRunItems(triggerKind, text)
  if (diagram) body.diagram = diagram
  return body
}

export const startedWord = (n: number) => `Started ${n} ${n === 1 ? 'run' : 'runs'}`

export const diagramLabel = (d: DiagramRef) =>
  `${d.dir.replace(/-\d{8}-\d{6}$/, '').replace(/[-_]+/g, ' ')}, ${d.folder} on ${d.machine}`

export function addItem(text: string, item: string): string {
  const items = text.split(/[\s,]+/).filter(Boolean)
  if (items.some((x) => x.toLowerCase() === item.toLowerCase())) return text
  return [...items, item].join(' ')
}

export const askDispatchText = (d: Pick<Definition, 'name' | 'id'>) => `Change the pipeline "${d.name}" (${d.id}): `

export function noRunsText(triggerKind: string): string {
  return `No runs yet. ${['manual', 'schedule'].includes(triggerKind) ? 'Run it now, or' : 'Run it now with a ticket or link, or'} switch it on and let its trigger start one.`
}

export type FeedPipelineRow = { serverId: string; machine: string; waiting: number }

export function pipelineFeedRows(servers: { server: { id: string; machine: string }; state?: { runs_waiting?: number } }[]): FeedPipelineRow[] {
  return servers.flatMap(({ server, state }) => {
    const waiting = state?.runs_waiting ?? 0
    return waiting > 0 ? [{ serverId: server.id, machine: server.machine, waiting }] : []
  })
}

export function pipelineFeedSubtitle(row: FeedPipelineRow, serverCount: number): string {
  const text = row.waiting === 1 ? '1 run waits for you' : `${row.waiting} runs wait for you`
  return serverCount > 1 ? `${text} · ${row.machine}` : text
}

export const pipelinesHref = (serverId: string) => `/pipelines/${encodeURIComponent(serverId)}`
export const pipelineHref = (serverId: string, id: string) => `${pipelinesHref(serverId)}/${encodeURIComponent(id)}`
export const runHref = (serverId: string, runId: string, pipeline?: string) =>
  `${pipelinesHref(serverId)}/run/${encodeURIComponent(runId)}${pipeline ? `?p=${encodeURIComponent(pipeline)}` : ''}`
