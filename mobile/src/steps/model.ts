import type { ActionEvent, Decision } from '../dispatch/types'

export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'rejected' | 'withdrawn'

export type Tone = 'ok' | 'warn' | 'error' | 'muted'

export type ReviewInfo = {
  scan?: string
  name?: string
  branch?: string
  path?: string
  pull?: { forge?: string; number?: number; url?: string; base?: string }
}

export type Draft = Record<string, string | boolean>

export class StepEditError extends Error {}

const TITLES: Record<string, string> = {
  start_session: 'Start a session',
  send_to_session: 'Type into a session',
  stop_session: 'Stop a session',
  remove_worktree: 'Remove a worktree',
  integrate_branches: 'Integrate branches',
  push_branch: 'Push a branch',
  move_session: 'Move a session',
  call_connector: 'Call a connected tool',
  save_connector: 'Save a connection'
}

const MEMORY_TITLES: Record<string, string> = { add: 'Remember this', replace: 'Change a memory', forget: 'Forget a memory' }

const SETTINGS_AREAS: Record<string, string> = {
  dispatch: 'Dispatch',
  triggers: 'Triggers',
  worktree_setup: 'Worktree setup',
  agents: 'Agents',
  session_mcp_servers: 'Connections for sessions',
  phone: 'Phone notifications',
  health_checks: 'Health checks',
  machines: 'Machines',
  pipelines: 'Pipelines',
  pull_requests: 'Pull requests'
}

const RUN_ACTIONS: Record<string, string> = { answer: 'Answer', retry: 'Retry', continue_pass: 'Continue', continue_fail: 'Continue', drop: 'Drop' }
const RUN_DONE: Record<string, string> = { queued: 'Queued', running: 'Running again', waiting: 'Still waiting', done: 'Finished', dropped: 'Dropped' }

const SCANS: Record<string, string> = { dead_code: 'Dead code scan', test_gaps: 'Test gap scan', security: 'Security scan' }
const SCAN_WHAT: Record<string, string> = {
  dead_code: 'unused functions, modules, routes, assets and config',
  test_gaps: 'important code without tests, and runs the tests',
  security: 'secrets, injection, unsafe input, missing auth checks and advisories'
}

const MINE: Record<string, { go: string; done: string; edited: string; waiting: string }> = {
  review: { go: 'Start review', done: 'Started', edited: 'started', waiting: 'Not started' },
  scan: { go: 'Start scan', done: 'Started', edited: 'started', waiting: 'Not started' },
  start_session: { go: 'Start session', done: 'Started', edited: 'started', waiting: 'Not started' },
  send_to_session: { go: 'Send', done: 'Sent', edited: 'sent', waiting: 'Not sent' }
}

const RULE_STEPS: Record<string, string> = {
  draw_diagram: 'draw diagrams',
  save_connector: 'save connections',
  call_connector: 'call connected tools',
  start_session: 'start sessions',
  stop_session: 'stop sessions',
  send_to_session: 'type into sessions',
  review_session: 'start reviews',
  scan_folder: 'start scans',
  remove_worktree: 'remove worktrees',
  integrate_branches: 'integrate branches',
  push_branch: 'push branches',
  merge_pull: 'merge pull requests',
  move_session: 'move sessions',
  remember: "change Dispatch's memory",
  change_settings: 'change settings',
  save_task: 'save tasks',
  run_trigger: 'run triggers',
  save_pipeline: 'save pipelines',
  set_pipeline_enabled: 'turn pipelines on or off',
  run_pipeline: 'run pipelines',
  answer_run: 'answer runs'
}

export const MEMORY_LIMIT = 500
const LONG_CHARS = 420
const LONG_LINES = 6
const BRIEF_CHARS = 200
const DIFF_CONTEXT = 3

const input = (step: ActionEvent): Record<string, any> => step.input ?? {}
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export function reviewOf(step: ActionEvent): ReviewInfo | null {
  const review = step.review
  return review !== null && typeof review === 'object' ? (review as ReviewInfo) : null
}

function scanOf(step: ActionEvent): string | null {
  const scan = reviewOf(step)?.scan
  return scan !== undefined && SCANS[scan] !== undefined ? scan : null
}

export function areaName(area: unknown): string {
  const key = text(area)
  return SETTINGS_AREAS[key] ?? key
}

function mineWords(step: ActionEvent) {
  return MINE[scanOf(step) !== null ? 'scan' : reviewOf(step) ? 'review' : step.tool] ?? MINE.start_session
}

export function stepState(step: ActionEvent, inFlight: Decision | null = null): StepState {
  if (inFlight !== null || ((step.status === 'approved' || step.status === 'edited') && !step.result)) return 'running'
  if (step.status === 'pending') return 'pending'
  if (step.status === 'rejected' || step.status === 'withdrawn') return step.status
  return step.result && !step.result.ok ? 'failed' : 'done'
}

export function stepTitle(step: ActionEvent): string {
  const i = input(step)
  const scan = scanOf(step)
  if (scan) return `Start a ${SCANS[scan].toLowerCase()}`
  switch (step.tool) {
    case 'remember':
      return MEMORY_TITLES[i.change] ?? MEMORY_TITLES.add
    case 'change_settings':
      return `Change Settings: ${areaName(i.area)}`
    case 'save_task':
      return `Save the task ${text(i.name)}`.trim()
    case 'run_trigger':
      return `Run the trigger ${text(i.name)}`.trim()
    case 'save_pipeline':
      return `${i.before ? 'Change the pipeline' : 'New pipeline:'} ${text(i.definition?.name)}`.trim()
    case 'set_pipeline_enabled':
      return `${i.on ? 'Turn on' : 'Turn off'} ${text(i.name)}`.trim()
    case 'run_pipeline':
      return `Run ${text(i.name)}`.trim()
    case 'draw_diagram':
      return `Draw a diagram in ${text(i.folder) || text(i.new_folder) || 'a folder'}`
    case 'answer_run': {
      const how = i.action === 'continue_pass' ? ' as passed' : i.action === 'continue_fail' ? ' as failed' : ''
      return `${RUN_ACTIONS[i.action] ?? 'Answer'} ${text(i.subject)}${how}`.trim()
    }
  }
  return reviewOf(step) ? 'Start a review' : (TITLES[step.tool] ?? step.tool)
}

export function whereLine(step: ActionEvent): string {
  const i = input(step)
  const review = reviewOf(step)
  const agent = agentName(i.agent)
  if (scanOf(step) && review) return `${review.path ?? i.path ?? ''} on ${i.machine ?? ''} · ${agent}`
  if (review) return `of ${review.name ?? ''} on ${i.machine ?? ''}${review.branch ? ` · ${review.branch}` : ''} · ${agent}`
  switch (step.tool) {
    case 'remove_worktree':
      return `${i.folder ?? i.path ?? ''} on ${i.machine ?? ''}`
    case 'integrate_branches':
      return `${i.machine ?? ''} · ${i.folder ?? i.path ?? ''} · into ${i.into ?? ''}`
    case 'push_branch':
      return `${i.branch ?? ''} on ${i.machine ?? ''} to ${i.remote || 'origin'}`
    case 'move_session':
      return `${i.name ?? ''} from ${i.machine ?? ''} to ${i.to || 'the machine with the most room'}`
    case 'remember':
      return "Dispatch's memory, read at the start of every turn"
    case 'change_settings':
      return `Settings, ${areaName(i.area)}`
    case 'save_task':
      return i.before ? 'A new version of a saved task' : 'A new task'
    case 'run_trigger':
      return 'Runs it now, as Run now in Settings does'
    case 'save_pipeline':
      return i.before ? `Pipelines, version ${i.before.version} to the next` : 'Pipelines, a new pipeline, saved switched off'
    case 'set_pipeline_enabled':
    case 'run_pipeline':
      return `Pipelines, ${i.id ?? ''}`
    case 'answer_run':
      return `A run of ${i.pipeline ?? ''}`
    case 'save_connector':
      return `${i.connector?.name ?? ''} · can reach ${i.host ?? ''}`
    case 'call_connector':
      return `${i.connector ?? ''} · ${i.call ?? ''}`
    case 'start_session': {
      const branch = i.branch ? ` · ${i.branch}${i.new_branch ? ` new${i.base ? ` from ${i.base}` : ''}` : ''}` : ''
      const folder = text(i.folder) || text(i.path)
      return `${i.machine ?? ''}${folder ? ` · ${folder}` : ''}${branch} · ${agent}`
    }
  }
  return `${i.name ?? ''} on ${i.machine ?? ''}`
}

function agentName(agent: unknown): string {
  return text(agent) || 'the default agent'
}

export function badge(step: ActionEvent, state: StepState): { label: string; tone: Tone } {
  const mine = step.by === 'you'
  if (state === 'done' && stoppedShort(step)) return { label: 'Stopped at a conflict', tone: 'warn' }
  switch (state) {
    case 'pending':
      return { label: mine ? mineWords(step).waiting : 'Waiting for you', tone: 'warn' }
    case 'running':
      return { label: 'Running', tone: 'muted' }
    case 'failed':
      return { label: 'Failed', tone: 'error' }
    case 'rejected':
      return { label: mine ? 'Cancelled' : 'Rejected', tone: 'muted' }
    case 'withdrawn':
      return { label: 'Withdrawn', tone: 'muted' }
    default:
      return { label: 'Done', tone: 'ok' }
  }
}

export function approveLabel(step: ActionEvent): string {
  if (step.already) return 'Review again'
  return step.by === 'you' ? mineWords(step).go : 'Approve'
}

export function rejectLabel(step: ActionEvent): string {
  return step.by === 'you' ? 'Cancel' : 'Reject'
}

export function canEdit(step: ActionEvent): boolean {
  if (['start_session', 'send_to_session', 'save_task'].includes(step.tool)) return true
  return step.tool === 'remember' && input(step).change !== 'forget'
}

export function startDraft(step: ActionEvent): Draft {
  const i = input(step)
  switch (step.tool) {
    case 'send_to_session':
      return { text: text(i.text) }
    case 'save_task':
      return { text: text(i.text) }
    case 'remember':
      return { entry: text(i.entry) }
  }
  const draft: Draft = {}
  for (const [key, value] of Object.entries(i)) {
    if (typeof value === 'string' || typeof value === 'boolean') draft[key] = value
  }
  return draft
}

export function editedInput(step: ActionEvent, draft: Draft): Record<string, unknown> {
  const i = input(step)
  switch (step.tool) {
    case 'send_to_session': {
      const typed = text(draft.text)
      if (typed.trim() === '') throw new StepEditError('Write the text to type into the session.')
      return { ...i, text: typed }
    }
    case 'save_task': {
      const saved = text(draft.text)
      if (saved.trim() === '') throw new StepEditError('A saved task needs some text.')
      return { name: i.name, text: saved, before: i.before }
    }
    case 'remember': {
      const entry = text(draft.entry).trim()
      if (entry === '') throw new StepEditError('Write what Dispatch should remember.')
      if (entry.length > MEMORY_LIMIT) throw new StepEditError(`A memory is at most ${MEMORY_LIMIT} characters. This one is ${entry.length}.`)
      return { ...i, entry }
    }
  }
  const next: Record<string, unknown> = { ...draft }
  for (const key of Object.keys(next)) {
    if ((next[key] === '' || next[key] === false) && !(key in i)) delete next[key]
  }
  if (!draft.new_branch) delete next.base
  return next
}

export function editedFields(step: ActionEvent): string {
  const was = step.original
  if (!was) return ''
  const i = input(step)
  const old = (key: string) => text(was[key])
  const now = (key: string) => text(i[key])
  const fields: string[] = []
  if (old('machine') !== now('machine')) fields.push(`machine (was ${old('machine')})`)
  if (old('folder') !== now('folder') || old('path') !== now('path')) fields.push(`folder (was ${old('folder') || old('path') || 'none'})`)
  if (old('branch') !== now('branch') || Boolean(was.new_branch) !== Boolean(i.new_branch)) fields.push(`branch (was ${old('branch') || 'the current one'})`)
  if (old('agent') !== now('agent')) fields.push(`agent (was ${agentName(old('agent'))})`)
  if (old('prompt') !== now('prompt')) fields.push(reviewOf(step) ? 'instructions' : 'task')
  if (old('text') !== now('text')) fields.push('text')
  if (old('entry') !== now('entry')) fields.push('entry')
  if ('value' in was && JSON.stringify(was.value) !== JSON.stringify(i.value)) fields.push('settings')
  return fields.length > 1 ? `${fields.slice(0, -1).join(', ')} and ${fields.at(-1)}` : (fields[0] ?? '')
}

export function editNote(step: ActionEvent): { text: string; proposed?: string; proposedLabel: string } | null {
  if (step.status !== 'edited' || !step.original) return null
  const what = editedFields(step)
  const i = input(step)
  const proposed = step.original.prompt ?? step.original.text ?? step.original.entry
  const now = i.prompt ?? i.text ?? i.entry
  const differs = typeof proposed === 'string' && proposed !== now
  return {
    text: `Edited before it ran${what ? `: you changed the ${what}` : ''}.`,
    proposed: differs ? proposed : undefined,
    proposedLabel: step.by === 'you' ? 'What it started with' : 'What Dispatch proposed'
  }
}

export function clock(stamp: string | undefined, now: Date = new Date()): string {
  if (!stamp) return ''
  const at = new Date(stamp)
  if (Number.isNaN(at.getTime())) return ''
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString()} ${time}`
}

export function ruleText(r: NonNullable<ActionEvent['rule']>): string {
  const action = RULE_STEPS[r.action ?? ''] ?? 'any step'
  if (['save_connector', 'call_connector', 'remember', 'change_settings', 'save_task', 'run_trigger', 'save_pipeline', 'set_pipeline_enabled', 'run_pipeline', 'answer_run'].includes(r.action ?? '')) return action
  const machine = !r.machine || r.machine === 'any' ? 'any machine' : r.machine
  return `${action} on ${machine}${r.folder ? ` in ${r.folder}` : ''}`
}

export function trail(step: ActionEvent, state: StepState, inFlight: Decision | null = null): string {
  const parts: string[] = []
  const mine = step.by === 'you'
  const words = mineWords(step)
  const review = reviewOf(step)
  if (step.by === 'pipeline') parts.push(`Ran as part of the pipeline run started at ${clock(step.at)}`)
  else if (step.status === 'auto') parts.push(`Ran without asking ${clock(step.at)}`)
  else if (step.by === 'client') parts.push(`Proposed by ${step.from ?? 'a connected client'} ${clock(step.at)}`)
  else if (step.by === 'yardbell') parts.push(`Proposed by Yardbell when ${review?.pull?.number ? `#${review.pull.number}` : 'the pull request'} got new commits ${clock(step.at)}`)
  else parts.push(`${mine ? 'You asked for this' : 'Proposed by Dispatch'} ${clock(step.at)}`)
  if (step.rule !== undefined) parts.push(`Your rule: ${ruleText(step.rule)}`)
  if (step.status === 'approved') parts.push(`${mine ? words.done : 'Approved'} ${clock(step.decided)}`)
  if (step.status === 'edited') parts.push(`Edited and ${mine ? words.edited : 'approved'} ${clock(step.decided)}`)
  if (step.status === 'rejected') parts.push(`${mine ? 'Cancelled' : 'Rejected'} ${clock(step.decided)}`)
  if (step.status === 'withdrawn') parts.push(`Withdrawn ${clock(step.decided)} when you sent a new message`)
  if (state === 'running' && inFlight !== 'reject') parts.push('Running…')
  return parts.map((part) => part.replace(/\s+/g, ' ').trim()).join(' · ')
}

export type Outcome = { tone: Tone; text: string; note?: string; session?: { machine: string; name: string } }

function parsed(raw: string): Record<string, any> | null {
  try {
    const value = JSON.parse(raw)
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function worktreeOutcome(tool: string, raw: string): { text: string; stopped: boolean } | null {
  const v = parsed(raw)
  if (!v) return null
  switch (tool) {
    case 'remove_worktree':
      return { text: v.removed?.note || 'Removed', stopped: false }
    case 'integrate_branches':
      return { text: v.summary || 'Integrated', stopped: Boolean(v.integrated?.conflict) }
    case 'push_branch':
      return { text: `Pushed ${v.pushed?.branch} to ${v.pushed?.remote}`, stopped: false }
    case 'move_session':
      return { text: `Moved to ${v.machine} as ${v.name}${v.from?.stopped ? `; ${v.from.name} stopped` : ''}`, stopped: false }
  }
  return null
}

function stoppedShort(step: ActionEvent): boolean {
  return step.tool === 'integrate_branches' && Boolean(worktreeOutcome(step.tool, step.result?.text ?? '')?.stopped)
}

export function outcomeOf(step: ActionEvent, state: StepState): Outcome | null {
  const result = step.result
  if (state === 'failed' && result) return { tone: 'error', text: result.text }
  if (state !== 'done' || !result) return null
  const i = input(step)
  const session = result.session
  if (step.tool === 'start_session' && session) {
    return { tone: 'ok', text: `Started ${session.name} on ${session.machine}`, session }
  }
  const said = worktreeOutcome(step.tool, result.text)
  if (said?.stopped) return { tone: 'warn', text: said.text }
  if (said) return { tone: 'ok', text: said.text, session }
  const v = parsed(result.text)
  switch (step.tool) {
    case 'change_settings':
      return { tone: 'ok', text: 'Saved. Undo it in Settings.', note: v?.note }
    case 'save_task':
      return { tone: 'ok', text: `Saved as version ${v?.version ?? 1}` }
    case 'save_pipeline':
      if (v) return { tone: 'ok', text: `Saved as version ${v.version}`, note: v.note ? `${v.note} It replaced version ${v.replaced}.` : undefined }
      break
    case 'set_pipeline_enabled':
      if (v) return { tone: 'ok', text: v.enabled ? 'Turned on' : 'Turned off' }
      break
    case 'run_pipeline':
      if (v) {
        const n = v.runs?.length ?? 0
        return { tone: 'ok', text: `Started ${n} ${n === 1 ? 'run' : 'runs'}` }
      }
      break
    case 'answer_run':
      if (v) return { tone: 'ok', text: RUN_DONE[v.state] ?? 'Done' }
      break
    case 'run_trigger':
      return { tone: 'ok', text: v?.text || (v?.conversation ? 'Started' : 'Done') }
    case 'remember':
      return { tone: 'ok', text: i.change === 'forget' ? 'Forgotten' : 'Saved to memory' }
  }
  return { tone: 'ok', text: ({ send_to_session: 'Sent', stop_session: 'Stopped' } as Record<string, string>)[step.tool] ?? 'Done' }
}

export type DiffRow = { op: 'add' | 'del' | 'same' | 'gap'; text: string }

export type DiffPart = { op: 'add' | 'del' | 'same'; text: string }

function lines(value: string): string[] {
  const all = value.split('\n')
  return all.length > 1 && all.at(-1) === '' ? all.slice(0, -1) : all
}

export function diffRows(parts: DiffPart[]): DiffRow[] {
  const rows: DiffRow[] = []
  parts.forEach((part, at) => {
    const own = lines(part.text ?? '')
    if (part.op !== 'same') {
      for (const line of own) rows.push({ op: part.op, text: line })
      return
    }
    const first = at === 0
    const last = at === parts.length - 1
    if (own.length <= DIFF_CONTEXT * 2 + 1) {
      for (const line of own) rows.push({ op: 'same', text: line })
      return
    }
    if (!first) for (const line of own.slice(0, DIFF_CONTEXT)) rows.push({ op: 'same', text: line })
    rows.push({ op: 'gap', text: '…' })
    if (!last) for (const line of own.slice(-DIFF_CONTEXT)) rows.push({ op: 'same', text: line })
  })
  return rows
}

export function hasChange(parts: DiffPart[]): boolean {
  return parts.some((part) => part.op !== 'same')
}

export function memoryRows(i: Record<string, any>): DiffRow[] {
  const removed = i.change === 'add' ? '' : text(i.old)
  const added = i.change === 'forget' ? '' : text(i.entry)
  return [...(removed ? [{ op: 'del' as const, text: removed }] : []), ...(added ? [{ op: 'add' as const, text: added }] : [])]
}

export function isLong(value: string, brief = false): boolean {
  return brief ? value.length > BRIEF_CHARS || value.includes('\n') : value.length > LONG_CHARS || value.split('\n').length > LONG_LINES
}

export type Block =
  | { kind: 'label'; text: string }
  | { kind: 'text'; text: string; muted?: boolean; warn?: boolean }
  | { kind: 'long'; text: string }
  | { kind: 'mono'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'diff'; rows: DiffRow[] }
  | { kind: 'nochange' }
  | { kind: 'code'; text: string }
  | { kind: 'fold'; summary: string; text: string }

const EDIT_ON_COMPUTER = 'To change this, edit it on the computer. Here you can approve or reject it.'

function pipelineBlocks(i: Record<string, any>): Block[] {
  const c = i.changes ?? {}
  const blocks: Block[] = []
  const steps: any[] = i.definition?.steps ?? []
  if (steps.length) blocks.push({ kind: 'label', text: `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}` }, { kind: 'list', items: steps.map((s) => `${s.name ?? ''} (${s.kind ?? 'step'})`) })
  const said: string[] = []
  if (c.trigger && i.definition?.trigger) said.push('The trigger changed.')
  if (c.added?.length) said.push(`Steps added: ${c.added.join(', ')}.`)
  if (c.removed?.length) said.push(`Steps removed: ${c.removed.join(', ')}.`)
  for (const x of c.changed ?? []) said.push(`${x.step}: ${(x.fields ?? []).join(', ')} changed.`)
  if (said.length) blocks.push({ kind: 'list', items: said })
  for (const w of c.wording ?? []) {
    blocks.push({ kind: 'label', text: `${w.step}: instructions` })
    blocks.push(w.diff && hasChange(w.diff) ? { kind: 'diff', rows: diffRows(w.diff) } : { kind: 'nochange' })
  }
  const unapproved = steps.filter((s) => s.kind === 'command' && s.approved !== s.command)
  for (const s of unapproved) blocks.push({ kind: 'label', text: `${s.name}: runs this command on a machine` }, { kind: 'code', text: text(s.command) })
  if (unapproved.length) {
    blocks.push({ kind: 'text', muted: true, text: `Approving saves the pipeline, not ${unapproved.length === 1 ? 'this command' : 'these commands'}. A run stops at each one and shows it to you before it runs.` })
  }
  blocks.push({ kind: 'text', muted: true, text: 'A new or changed pipeline always waits for you.' }, { kind: 'text', muted: true, text: EDIT_ON_COMPUTER })
  return blocks
}

function runBlocks(step: ActionEvent): Block[] {
  const i = input(step)
  if (step.tool === 'set_pipeline_enabled') {
    return [{ kind: 'text', muted: true, text: i.on ? 'It starts runs on its own from now on, as its trigger says.' : 'It stops starting runs on its own; runs already going carry on.' }]
  }
  if (step.tool === 'run_pipeline') {
    const subjects: string[] = [...(i.tickets ?? []), ...(i.prs ?? [])]
    return subjects.length ? [{ kind: 'list', items: subjects }] : [{ kind: 'text', muted: true, text: 'One run with no ticket or pull request.' }]
  }
  const w = i.waiting ?? {}
  const blocks: Block[] = [{ kind: 'label', text: `${i.subject ?? ''}, at ${w.step ?? ''}` }, { kind: 'text', text: text(w.reason) }]
  if (w.screen) blocks.push({ kind: 'fold', summary: 'What the session showed', text: text(w.screen) })
  if (i.action === 'answer') blocks.push({ kind: 'label', text: 'Answer' }, { kind: 'text', text: text(i.text) })
  return blocks
}

function changeBlocks(step: ActionEvent): Block[] {
  const i = input(step)
  if (step.tool === 'run_trigger') {
    return [{ kind: 'text', muted: true, text: 'A schedule starts its task in a new conversation now; a Linear or GitHub trigger checks for new items.' }]
  }
  const blocks: Block[] = []
  if (Array.isArray(i.diff)) {
    blocks.push(hasChange(i.diff) ? { kind: 'diff', rows: diffRows(i.diff) } : { kind: 'nochange' })
  } else {
    blocks.push({ kind: 'mono', text: step.tool === 'save_task' ? text(i.text) : JSON.stringify(i.value ?? i.change ?? {}, null, 2) })
  }
  if (Array.isArray(i.secrets) && i.secrets.length) {
    blocks.push({ kind: 'text', text: `It uses saved secrets: ${i.secrets.join(', ')}. A change that uses a saved secret always waits for you.` })
  }
  if (step.tool === 'change_settings' && i.area === 'dispatch') blocks.push({ kind: 'text', muted: true, text: "Dispatch's own settings always wait for you." })
  if (step.tool === 'change_settings') blocks.push({ kind: 'text', muted: true, text: EDIT_ON_COMPUTER })
  return blocks
}

export function bodyBlocks(step: ActionEvent): Block[] {
  const i = input(step)
  const scan = scanOf(step)
  const review = reviewOf(step)
  if (scan && review) {
    return [
      { kind: 'text', text: `A new session in ${review.path ?? i.path ?? ''} looks through all of its code for ${SCAN_WHAT[scan]}. It changes no files, and its findings come back here.` },
      { kind: 'fold', summary: 'Instructions for the scanner', text: text(i.prompt) }
    ]
  }
  if (review) {
    const pull = review.pull
    const target = pull ? `${pull.forge === 'gitlab' ? 'merge request' : 'pull request'} #${pull.number ?? ''} against ${pull.base || 'its base'}` : 'this branch'
    const blocks: Block[] = [{ kind: 'text', text: `A new session in ${i.path ?? review.path ?? ''} reviews ${target}, runs the tests and changes no files. Its findings come back here.` }]
    if (step.already && step.status === 'pending') blocks.push({ kind: 'text', warn: true, text: `${step.already.text ?? 'This was reviewed before.'} Nothing has changed since, so a new review would read the same code.` })
    blocks.push({ kind: 'fold', summary: 'Instructions for the reviewer', text: text(i.prompt) })
    return blocks
  }
  switch (step.tool) {
    case 'start_session':
      return i.prompt ? [{ kind: 'label', text: 'Task' }, { kind: 'long', text: text(i.prompt) }] : []
    case 'send_to_session':
      return [{ kind: 'label', text: 'Text' }, { kind: 'mono', text: text(i.text) }]
    case 'stop_session':
      return [{ kind: 'text', muted: true, text: 'Ends the tmux session and the agent in it.' }]
    case 'remove_worktree':
      return [{ kind: 'text', muted: true, text: `Runs git worktree remove and prunes${i.delete_branch ? ', and deletes the branch if it is merged' : ''}. It is refused if the worktree has uncommitted changes or commits no remote has; only you can remove those, from the dashboard.` }]
    case 'integrate_branches':
      return [
        { kind: 'label', text: `${i.method === 'rebase' ? 'Rebased' : 'Merged'} in this order onto a new branch from ${i.base ?? ''}` },
        { kind: 'list', items: Array.isArray(i.branches) ? i.branches.map(String) : [] },
        { kind: 'text', muted: true, text: 'It stops at the first conflict and pushes nothing.' }
      ]
    case 'push_branch':
      return [{ kind: 'text', muted: true, text: 'Every commit it would push is checked for keys, tokens and your saved secrets first, and a hit stops it. Never forced.' }]
    case 'remember': {
      const blocks: Block[] = [{ kind: 'diff', rows: memoryRows(i) }]
      if (i.reason) blocks.push({ kind: 'label', text: 'Why' }, { kind: 'text', text: text(i.reason) })
      return blocks
    }
    case 'change_settings':
    case 'save_task':
    case 'run_trigger':
      return changeBlocks(step)
    case 'save_pipeline':
      return pipelineBlocks(i)
    case 'set_pipeline_enabled':
    case 'run_pipeline':
    case 'answer_run':
      return runBlocks(step)
    case 'save_connector': {
      const shown = JSON.stringify({ base_url: i.connector?.base_url, headers: i.connector?.headers, calls: i.connector?.calls }, null, 2)
      return [
        { kind: 'text', muted: true, text: i.before ? 'Changes this connection.' : 'It arrives switched off, for you to check, add its secrets and switch on.' },
        { kind: 'label', text: 'What it would send' },
        { kind: 'code', text: shown }
      ]
    }
    case 'move_session': {
      const blocks: Block[] = [{ kind: 'text', muted: true, text: `The branch and its uncommitted changes go over ssh; nothing is committed or pushed. The same agent starts there with the task${i.stop_original ? ', and the original stops' : ''}.` }]
      if (i.task) blocks.push({ kind: 'label', text: 'Task' }, { kind: 'long', text: text(i.task) })
      return blocks
    }
  }
  return []
}

export function editForm(step: ActionEvent): 'session' | 'review' | 'text' | 'task' | 'entry' | null {
  switch (step.tool) {
    case 'send_to_session':
      return 'text'
    case 'save_task':
      return 'task'
    case 'remember':
      return 'entry'
    case 'start_session':
      return reviewOf(step) ? 'review' : 'session'
  }
  return null
}
