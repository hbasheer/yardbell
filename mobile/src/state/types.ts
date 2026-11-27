export type Activity = 'active' | 'idle' | 'blocked'

export type MachineView = {
  name: string
  up: boolean
  reason: string | null
  local: boolean
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

export type ServerView = {
  machine: string
  address: string
  version: string
}

export type StateView = {
  machines: MachineView[]
  sessions: SessionView[]
  server?: ServerView | null
}
