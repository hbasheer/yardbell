export type Activity = 'active' | 'idle' | 'blocked'

export type HealthView = {
  mem_total_kb: number
  mem_used_kb: number
  agent_kb: number
  user_kb: number
  limit_kb: number
  limit_used_kb: number
  load1: number
  cpus?: number
  disk_total_kb?: number
  disk_used_kb?: number
}

export type MachineView = {
  name: string
  up: boolean
  reason: string | null
  local: boolean
  health?: HealthView | null
}

export type PullView = {
  forge: string
  number: number
  url: string
  title: string
  state: string
  draft: boolean
  review: string
  ci?: string
  mergeable?: string
  head?: string
  base?: string
}

export type SessionView = {
  id: string
  machine: string
  agent: string
  pid?: number
  folder: string
  ticket?: string
  branch: string
  activity: Activity
  attachable: boolean
  tmux: string | null
  stale: boolean
  stopped?: string | null
  pull?: PullView | null
  path?: string
  cwd?: string
  worktree?: boolean
}

export type EndedView = {
  id: string
  machine: string
  folder: string
  ticket?: string
  branch?: string
  agent: string
  path?: string
  worktree?: boolean
}

export type ServerView = {
  machine: string
  address: string
  version: string
}

export type AgentView = { name: string; label: string; read_only?: boolean }

export type FolderView = {
  machine: string
  label: string
  path: string
  branch: string
  worktree?: boolean
}

export type StateView = {
  agents?: AgentView[]
  default_agent?: string
  machines: MachineView[]
  sessions: SessionView[]
  ended?: EndedView[]
  folders?: FolderView[]
  proposals?: number
  waiting?: number
  server?: ServerView | null
}
