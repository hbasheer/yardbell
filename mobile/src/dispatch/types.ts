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
}

export type GroupEvent = {
  role: 'group'
  id: string
  title: string
  gather?: boolean
  minutes?: number
  children: GroupChild[]
  status: GroupStatus
  follow?: boolean
}

export type ResultDetail = Record<string, unknown>

export type ResultChild = {
  label: string
  started?: boolean
  name?: string
  machine?: string
  path?: string
  branch?: string
  state?: string
  screen?: string
  result?: { status: string; summary?: string; details?: ResultDetail[] }
}

export type ResultsEvent = {
  role: 'results'
  group: string
  title: string
  why?: string
  children: ResultChild[]
  gather?: boolean
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

export type Finding = { severity: string; place?: string; text: string }

export type ReviewEvent = {
  role: 'review'
  machine: string
  name: string
  of?: Record<string, unknown>
  verdict?: string
  summary?: string
  findings?: Finding[]
  outcome?: unknown
}

export type PullEvent = {
  role: 'pull'
  kind: 'ci' | 'conflict' | 'comments'
  key?: string
  machine: string
  name: string
  path?: string
  branch?: string
  pull?: { number: number; url: string; title: string }
  checks?: unknown[]
  notes?: unknown[]
  instruction?: string
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
