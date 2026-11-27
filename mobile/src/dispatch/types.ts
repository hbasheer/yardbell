import type { Activity, PullView } from '../state/types'

export type Backend = 'claude' | 'codex'

export type TaskMark = { name: string; version: number }
export type ImproveMark = { machine: string; name: string; task?: TaskMark }

export type AttachmentKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'pdf' | 'text'

export type StoredAttachment = { file: string; name: string; kind: string; size: number }

export type UserEvent = {
  role: 'user'
  text: string
  attachments?: StoredAttachment[]
  by?: string
  task?: TaskMark
  improve?: ImproveMark
}

export type AssistantEvent = { role: 'assistant'; text: string }

export type ToolEvent = { role: 'tool'; name: string; input?: unknown }

export type ToolResultEvent = { role: 'tool_result'; name: string; text: string; is_error?: boolean }

export type StepStatus = 'pending' | 'approved' | 'edited' | 'auto' | 'rejected' | 'withdrawn'

export type StepResult = {
  ok: boolean
  text: string
  at?: string
  session?: { machine: string; name: string; path?: string }
}

export type ActionEvent = {
  role: 'action'
  id: string
  tool: string
  input: Record<string, unknown>
  status: StepStatus
  by?: 'dispatch' | 'you' | 'pipeline' | 'yardbell' | 'client'
  from?: string
  at?: string
  decided?: string
  rule?: { action?: string; machine?: string; folder?: string; approval?: string }
  original?: Record<string, unknown>
  result?: StepResult
  review?: unknown
  group?: string
  label?: string
  already?: { text?: string; conversation?: string }
  told?: boolean
}

export type GroupStatus = 'waiting' | 'running' | 'gathering' | 'gathered' | 'dropped'

export type GroupChild = {
  label: string
  step?: string
  refused?: string
  rule?: string
  state?: string
  worked?: boolean
}

export type GroupEvent = {
  role: 'group'
  id: string
  title: string
  gather?: string | boolean
  minutes?: number
  at?: string
  started?: string
  gathered?: string
  children: GroupChild[]
  status: GroupStatus
  follow?: boolean
}

export type ResultChild = {
  label: string
  note?: string
  started?: boolean
  worked?: boolean
  name?: string
  machine?: string
  path?: string
  branch?: string
  state?: string
  screen?: string
  result?: { status: string; summary?: string; details?: string[] }
}

export type ResultsEvent = {
  role: 'results'
  group: string
  title: string
  why?: string
  minutes?: number
  at?: string
  children: ResultChild[]
  gather?: string | boolean
  follow?: boolean
}

export type SessionState = 'blocked' | 'idle' | 'ended'

export type SessionOption = { key: string; label: string }

export type SessionEvent = {
  role: 'session'
  machine: string
  name: string
  path?: string
  state: SessionState
  screen?: string
  options?: SessionOption[]
  answer?: { key: string; label: string; at?: string }
  review?: unknown
}

export type PullRef = { number: number; url?: string; title?: string; base?: string; forge?: string; head?: string }

export type Finding = { severity: string; place?: string; text: string }

export type ReviewOf = {
  name?: string
  branch?: string
  path?: string
  scan?: string
  pull?: PullRef
}

export type ReviewOutcome = {
  decision: 'sent' | 'started' | 'dismissed'
  findings?: number[]
  to?: string
  step?: string
  at?: string
}

export type ReviewEvent = {
  role: 'review'
  machine: string
  name: string
  of?: ReviewOf
  verdict?: string
  summary?: string
  findings?: Finding[]
  outcome?: ReviewOutcome
  at?: string
}

export type PullCheck = { name: string; url?: string; log?: string }

export type PullNote = { kind?: string; author?: string; body?: string; url?: string; place?: string }

export type PullEvent = {
  role: 'pull'
  kind: 'ci' | 'conflict' | 'comments' | 'limit'
  key?: string
  machine: string
  name: string
  path?: string
  branch?: string
  folder?: string
  pull?: PullRef
  checks?: PullCheck[]
  notes?: PullNote[]
  more?: number
  error?: string
  resets?: string
  instruction?: string
  sent?: { at?: string; step?: string }
  at?: string
}

export type ErrorEvent = { role: 'error'; text: string }

export type DispatchEvent =
  | UserEvent
  | AssistantEvent
  | ToolEvent
  | ToolResultEvent
  | ActionEvent
  | GroupEvent
  | ResultsEvent
  | SessionEvent
  | ReviewEvent
  | PullEvent
  | ErrorEvent

export type StreamLine = DispatchEvent | { role: 'conversation'; id: string } | { role: 'done' }

export type ReviewTarget = { machine: string; name: string; agent?: string; branch?: string; path?: string }

export type Trigger = {
  name: string
  task?: string
  version?: number
  what?: string
  at?: string
  slot?: string
  url?: string
}

export type TrackedSession = { machine: string; name: string }

export type ConversationSummary = {
  id: string
  title: string
  updated: string
  busy: boolean
  waiting: number
  trigger: string | null
  backend?: Backend
}

export type Conversation = {
  id: string
  title: string
  updated: string
  events: DispatchEvent[]
  sessions: TrackedSession[]
  busy: boolean
  trigger?: Trigger | null
  backend?: Backend
}

export type SavedPrompt = {
  name: string
  text: string
  version: number
  builtin?: boolean
  customised?: boolean
  hidden?: boolean
}

export type PromptVersion = { n: number; text: string; at: string; restored?: number }

export type PromptHistory = { name: string; builtin: boolean; current: number; versions: PromptVersion[] }

export type PromptDiff = {
  name: string
  from: number
  to: number
  parts: { op: 'add' | 'del' | 'same'; text: string }[]
}

export type RunsOn = {
  runs_on: Backend
  label: string
  model: string
  agents: Record<string, { label?: string; model?: string }>
  voice_input: boolean
  voice_mode: string
}

export type Decision = 'approve' | 'reject'

export type AskAttachment = { name: string; data: string }

export type AskRequest = {
  conversation?: string
  text: string
  task?: TaskMark
  improve?: ImproveMark
  attachments?: AskAttachment[]
}

export type ReviewFileStat = {
  path: string
  old_path?: string
  status: string
  added?: number | null
  removed?: number | null
  binary: boolean
  untracked: boolean
}

export type ReviewChanges = {
  base: string
  merge_base: string
  head: string
  files: ReviewFileStat[]
  truncated: boolean
  reviewed_head: string | null
  moved: boolean
}

export type ReviewDiffLine = { k: 'hunk' | 'ctx' | 'add' | 'del'; o: number | null; n: number | null; t: string }

export type ReviewFilePage = {
  path: string
  binary: boolean
  notes?: string[]
  lines: ReviewDiffLine[]
  from: number
  next: number
  total: number
  cut: boolean
}

export type ScanFiles = { folder: string; files: string[] }

export type ReviewStanding = 'same' | 'moved' | 'uncommitted' | 'unknown'

export type ReviewPin = { head?: string; top?: string; changes?: string; error?: string }

export type ReviewCommit = { standing: ReviewStanding; now: ReviewPin }

export type InsightPeriod = { state: 'working' | 'waiting' | 'idle'; from: string; to: string | null; seconds: number }

export type InsightMark = { at: string; kind: 'tool' | 'test' | 'pull' | string; text?: string; ok?: boolean | null; url?: string }

export type InsightTimeline = {
  machine: string
  name: string
  agent: string
  folder: string
  branch: string
  since: string
  started: boolean
  ended: string | null
  periods: InsightPeriod[]
  totals: { working: number; waiting: number; idle: number }
  runs: InsightMark[]
  dropped: number
}

export type InsightPart = {
  asked?: string[]
  question?: string
  stopped_at?: string
  summary?: string
  said?: string
  did: { tool: string; what: string }[]
  files?: string[]
  more?: number
}

export type Insights = {
  machine: string
  name: string
  live: boolean
  attachable: boolean
  activity: Activity | null
  work: { title?: string; first_prompt?: string; screen?: string; [key: string]: unknown } | null
  parts: { before?: InsightPart; periods: InsightPart[] } | null
  timeline: InsightTimeline | null
  earlier: Omit<InsightMark, 'at'>[]
  scrollback_error: string | null
  task: string
  conversation: string | null
  pull: PullView | null
  suggest: string
  from?: { name: string; version: number; current: number }
}
