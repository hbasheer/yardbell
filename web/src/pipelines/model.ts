export type Outcome = 'pass' | 'fail' | 'needs_you'
export const OUTCOMES: Outcome[] = ['pass', 'fail', 'needs_you']
export const WORDS: Record<string, string> = { pass: 'passed', fail: 'failed', needs_you: 'needs you' }
export const LINE_WORDS: Record<string, string> = { pass: 'pass', fail: 'fail', needs_you: 'needs you' }

export type Step = {
  id: string
  name: string
  kind: string
  x: number
  y: number
  next: Partial<Record<Outcome, string>>
  [key: string]: unknown
}
export type Trigger = { kind: string; [key: string]: unknown }
export type Definition = {
  id: string
  name: string
  version: number
  enabled: boolean
  start: string
  steps: Step[]
  trigger: Trigger
  token_limit?: number | null
  [key: string]: unknown
}
export type Counts = { running?: number; waiting?: number; held?: number; done?: number }
export type Listed = { definition: Definition; runs: Counts; problem?: string }
export type Connector = { id: string; name: string; params?: { name: string; label?: string; filter?: boolean }[]; calls?: { name: string; kind?: string }[] }
export type Settings = { per_machine: number; minutes: number; memory_limit: number; token_limit?: number; qa_notes?: Record<string, string> }
export type PipelinesData = {
  pipelines: Listed[]
  templates: string[]
  agents: string[]
  agents_without_tokens?: string[]
  connectors: Connector[]
  default_agent: string
  machines: string[]
  settings: Settings
  [key: string]: unknown
}

export type StepState = {
  outcome?: Outcome
  started?: string
  ended?: string
  runs?: number
  machine?: string
  path?: string
  session?: string
  made?: string
  report?: string
  details?: string[]
  answer?: string
  overridden?: boolean
  ran?: { command: string; passed: boolean }
  pin?: { head?: string; changes?: boolean }
  watch?: { status?: string }
}
export type Run = {
  id: string
  pipeline: string
  pipeline_name?: string
  version?: number
  definition?: Definition
  state: 'queued' | 'running' | 'waiting' | 'done' | 'dropped'
  step: string
  step_since?: string
  started: string
  started_by?: string
  subject?: { ticket?: { id: string; title?: string; url?: string }; pr?: { number: number; url: string; forge?: string } }
  waiting?: { kind: string; step: string; reason?: string; screen?: string }
  held?: { kind: string; machine?: string; reason?: string; since?: string; told?: boolean }
  steps?: Record<string, StepState>
  history?: { at: string; step?: string; outcome?: Outcome; note?: string }[]
  questions?: { asked: string; answer?: string }[]
  tokens?: { limit?: number; unknown?: Record<string, string> }
  tokens_used?: number
  tokens_from_cache?: number
  report?: string
  pull?: { number: number; url: string }
  conversation?: string
  place?: { machine?: string; branch?: string }
  terminals?: { name: string; machine: string; label: string; current?: boolean }[]
  sessions_left?: { name: string; machine: string }[]
  teardown_problem?: string
}

export const ENDED = ['done', 'dropped']
export const ANSWERABLE = ['needs_you', 'asking', 'questions', 'no_result']
export const SUBJECTLESS = ['manual', 'schedule']

export const KINDS: Record<string, string> = {
  agent: 'Agent step',
  plan: 'Plan',
  push: 'Push and draft PR',
  update: 'Update the ticket',
  checks: 'Wait for CI and reviews',
  call: 'Use a connected tool',
  tool: 'Use a connected tool',
  command: 'Run a command',
  report: 'Report to me',
  wait: 'Wait for me'
}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  if (res.status === 401) {
    location.href = '/login'
    throw new Error('log in first')
  }
  const out = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(out.error || `Request failed (${res.status})`) as Error & { problems?: string[] }
    err.problems = out.problems || []
    throw err
  }
  return out as T
}

export function ago(stamp?: string) {
  if (!stamp) return ''
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(stamp)) / 60000))
  if (Number.isNaN(mins)) return ''
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min`
  if (mins < 1440) return `${Math.floor(mins / 60)} h`
  return `${Math.floor(mins / 1440)} d`
}

export function clock(stamp?: string) {
  if (!stamp) return ''
  const d = new Date(stamp)
  if (Number.isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

export function took(from?: string, to?: string) {
  if (!from || !to) return ''
  const secs = Math.round((Date.parse(to) - Date.parse(from)) / 1000)
  if (Number.isNaN(secs) || secs < 0) return ''
  if (secs < 60) return `${secs} s`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} min`
  return `${Math.floor(mins / 60)} h ${mins % 60} min`
}

export const tokens = (n?: number) => Number(n || 0).toLocaleString('en-US')

export function runLabel(run: Run) {
  const s = run.subject || {}
  const pr = s.pr ? `${s.pr.forge === 'gitlab' ? '!' : '#'}${s.pr.number}` : ''
  const ticket = s.ticket ? `${s.ticket.id} ${s.ticket.title || ''}`.trim() : ''
  return [pr, ticket].filter(Boolean).join(' ') || `Run started ${clock(run.started)}`
}

const isStep = (d: Definition, id?: string) => Boolean(id) && d.steps.some((s) => s.id === id)
export const nameOf = (d: Definition, id?: string) => d.steps.find((s) => s.id === id)?.name || id || ''

// The pass line from the start, with a step's fail line back to an earlier step shown as a loop on it.
export function flow(d: Definition) {
  const path: string[] = []
  let id: string | undefined = d.start
  while (id && isStep(d, id) && !path.includes(id)) {
    path.push(id)
    id = d.steps.find((s) => s.id === id)!.next.pass
  }
  return path.map((id) => {
    const step = d.steps.find((s) => s.id === id)!
    const fail = step.next.fail
    const back = fail && isStep(d, fail) && (!path.includes(fail) || path.indexOf(fail) <= path.indexOf(id))
    return { name: step.name, loop: back ? nameOf(d, fail) : '' }
  })
}

export function counts(c: Counts) {
  const parts: string[] = []
  if (c.running) parts.push(`${c.running} running`)
  if (c.waiting) parts.push(`${c.waiting} waiting`)
  if (c.held) parts.push(`${c.held} held a long time`)
  if (c.done) parts.push(`${c.done} done`)
  return parts.join(' · ') || 'No runs yet'
}

export const asksForYou = (r: Run) => r.state === 'waiting' || (r.state === 'queued' && Boolean(r.held?.told))

export function heldWord(h: NonNullable<Run['held']>) {
  if (h.kind === 'memory') return `${h.machine} is short of memory`
  if (h.kind === 'settling') return `${h.machine} is back under its memory limit, waiting two minutes`
  return 'next start on this machine is within a minute'
}

export function stateWord(run: Run, d: Definition) {
  const step = nameOf(d, run.step)
  switch (run.state) {
    case 'waiting':
      return `Waiting for you at ${step} · ${ago(run.step_since)}`
    case 'queued':
      return run.held ? `${step}, held · ${heldWord(run.held)}` : `${step}, queued`
    case 'running':
      return `${step} · ${ago(run.step_since)}`
    case 'done':
      return `Done ${clock(run.history?.at(-1)?.at || run.step_since)}`
    default:
      return 'Dropped'
  }
}

// An agent that passed without saying what it did leaves the next step and the person guessing.
export const silentPass = (step: Step, st?: StepState) => Boolean(st && st.outcome === 'pass' && ['agent', 'plan'].includes(step.kind) && !st.report?.trim())

export type NodeState = { cls: '' | 'waiting' | 'now' | 'done' | 'failed' | 'later'; mark: string; note: string }

export function nodeState(run: Run | null, step: Step): NodeState {
  if (!run) return { cls: '', mark: '', note: '' }
  const st = run.steps?.[step.id]
  const current = run.step === step.id && ['queued', 'running', 'waiting'].includes(run.state)
  if (current && run.state === 'waiting') {
    const reason = run.waiting?.reason || 'waiting'
    const note = run.waiting?.kind === 'needs_you' ? 'needs you' : reason.startsWith(`${step.name} `) ? reason.slice(step.name.length + 1) : reason
    return { cls: 'waiting', mark: '!', note }
  }
  if (current && step.kind === 'checks' && st?.watch?.status) return { cls: 'now', mark: '', note: `${st.watch.status} · ${ago(run.step_since)}` }
  if (current) return { cls: 'now', mark: '', note: run.state === 'queued' ? (run.held ? 'held' : 'queued') : `running · ${ago(run.step_since)}` }
  if (st?.outcome) {
    const runs = (st.runs || 0) > 1 ? ` · ${st.runs} runs` : ''
    const silent = silentPass(step, st) ? ' · no report' : ''
    return { cls: st.outcome === 'fail' ? 'failed' : 'done', mark: st.outcome === 'fail' ? '✗' : '✓', note: `${WORDS[st.outcome]}${runs}${silent}` }
  }
  return { cls: 'later', mark: '', note: 'not reached' }
}

export function machineWord(step: Step) {
  const m = (step.machine || {}) as { name?: string; same_as?: string; pick?: string[] }
  if ('name' in m && m.name) return m.name
  if ('same_as' in m && m.same_as) return `same machine as ${m.same_as}`
  return m.pick?.length ? m.pick.join(' or ') : 'any machine'
}

function workspaceWord(step: Step) {
  const w = (step.workspace || {}) as { kind?: string; step?: string; from?: string }
  if (w.kind === 'same_as') return `folder of ${w.step}`
  if (w.kind === 'copy') return `copy of ${w.from}`
  return 'new worktree'
}

let connectors: Connector[] = []
export const setConnectors = (list?: Connector[]) => {
  connectors = list || []
}
const connectorOf = (id?: unknown) => connectors.find((c) => c.id === id)
const connectorName = (id?: unknown) => connectorOf(id)?.name || (id as string) || 'a connected tool'

function filterWords(t: Trigger) {
  if (t.kind === 'connector') {
    const params = (t.params || {}) as Record<string, unknown>
    const chosen = (connectorOf(t.connector)?.params || []).filter((p) => p.filter && params[p.name])
    return chosen.length ? `filtered by ${chosen.map((p) => (p.label || p.name).toLowerCase()).join(' and ')}` : ''
  }
  const f = (t.filter || {}) as { labels?: string[]; teams?: string[]; projects?: string[] }
  const part = (word: string, list?: string[]) => (list?.length ? `${word} ${list.join(' or ')}` : '')
  return [part('label', f.labels), part('team', f.teams), part('project', f.projects)].filter(Boolean).join(', ')
}

export function triggerWords(t?: Trigger) {
  if (!t) return 'By hand, from Run now'
  const narrowed = filterWords(t) ? `, ${filterWords(t)}` : ''
  const states = t.states as string[] | undefined
  switch (t.kind) {
    case 'schedule':
      return `On the schedule ${t.schedule || '(not set)'}${t.state ? `, my open ${t.connector ? `${connectorName(t.connector)} items` : 'tickets'} in ${t.state}` : ''}`
    case 'connector':
      return `When ${connectorName(t.connector)} has a new item${states?.length ? ' in the states you picked' : ''}${narrowed}`
    case 'webhook':
      return "When another system calls this pipeline's web address"
    case 'linear':
      if (states?.length) return `When a Linear ticket${t.assigned ? ' of mine' : ''} moves to ${states.join(' or ')}${narrowed}`
      return `When a Linear ticket is assigned to me${narrowed}`
    case 'github_review':
      return 'When someone asks me to review a GitHub pull request'
    case 'gitlab_reviewer':
      return `When a GitLab merge request on ${t.host || 'a host you pick'} adds me as reviewer`
    default:
      return 'By hand, from Run now'
  }
}

export const TRIGGER_TAGS: Record<string, string> = {
  manual: 'by hand',
  schedule: 'schedule',
  linear: 'Linear',
  github_review: 'GitHub',
  gitlab_reviewer: 'GitLab',
  webhook: 'webhook',
  connector: 'connected tool'
}

// Every card says the same things in the same places: who does it, what it does and where.
export function describe(s: Step): { who: string; does: string; tags: string[] } {
  switch (s.kind) {
    case 'agent':
      return { who: s.read_only ? 'Agent · read only' : 'Agent', does: (s.instructions as string) || 'No instructions yet', tags: [machineWord(s), workspaceWord(s)] }
    case 'plan':
      return { who: 'Agent · Dispatch', does: 'Picks the machine, folder and branch, or asks you', tags: [(s.machines as string[])?.length ? (s.machines as string[]).join(' or ') : 'any machine'] }
    case 'push':
      return { who: 'Yardbell', does: 'Pushes the branch and opens a draft pull or merge request', tags: ['secret check', 'never forced'] }
    case 'checks':
      return {
        who: 'Yardbell',
        does: s.require_approval ? 'Waits for CI to pass and an approval, then follows pass or fail' : 'Waits for CI to pass, then follows pass or fail',
        tags: ['no agent', s.require_approval ? 'needs approval' : 'CI only']
      }
    case 'update':
      return { who: "Yardbell · the ticket's tool", does: s.action === 'move' ? `Moves the ticket to ${s.state || 'a state you pick'}` : 'Comments on the ticket, or drafts it for Linear', tags: [s.action === 'move' ? 'move' : 'comment'] }
    case 'call': {
      const call = connectorOf(s.connector)?.calls?.find((c) => c.name === s.call)
      return { who: `Yardbell · ${connectorName(s.connector)}`, does: s.call ? `Calls ${s.call}` : 'Pick a call', tags: [call?.kind === 'lookup' ? 'Reads' : 'Changes'] }
    }
    case 'tool':
      return { who: `Yardbell · ${s.server || 'MCP'}`, does: s.tool ? `Calls ${s.tool}` : 'Pick a tool', tags: [s.call_kind === 'lookup' ? 'Reads' : 'Changes'] }
    case 'command':
      return { who: 'Yardbell · no agent', does: (s.command as string) || 'No command yet', tags: [s.command && s.approved !== s.command ? 'Not approved yet' : 'Exit code decides'] }
    case 'report':
      return { who: 'Yardbell · Dispatch', does: 'Writes what the run found and tells you', tags: ['phone notification'] }
    case 'wait':
      return { who: 'You', does: (s.message as string) || 'Waits until you continue it', tags: ['needs you'] }
    default:
      return { who: '', does: '', tags: [] }
  }
}

// Deleting removes only the run's record, so the dialog names what is left behind.
export function staying(runs: Run[]) {
  const trees = [...new Set(runs.flatMap((r) => Object.values(r.steps || {}).filter((st) => st.made).map((st) => `${st.made} on ${st.machine}`)))]
  const open = runs.flatMap((r) => (r.sessions_left || []).map((t) => `${t.name} on ${t.machine}`))
  const lines = ['Branches, pushed commits, pull and merge requests, Dispatch conversations and the agents’ transcripts stay.']
  if (trees.length) lines.push(`${trees.length === 1 ? 'This worktree stays on disk' : 'These worktrees stay on disk'}: ${trees.join(', ')}.`)
  if (open.length) {
    const it = open.length === 1 ? 'it' : 'them'
    lines.push(
      `${open.length === 1 ? 'This session is still open and stays open' : 'These sessions are still open and stay open'}: ${open.join(', ')}. Stop ${it} from the dashboard when you no longer need ${it}.`
    )
  }
  return lines.join('\n')
}

export const TEMPLATE_HINTS: Record<string, string> = {
  'Implement my tickets': 'Plan, implement, review and fix, QA, push a draft, move the ticket, report',
  'Review my merge requests': 'Understand, root cause, security, test on devbox, report'
}
