export type Activity = 'active' | 'idle' | 'blocked'

export type MachineView = {
  name: string
  up: boolean
  reason: string | null
  local: boolean
}

export type SessionView = {
  id: string
  machine: string
  agent: string
  folder: string
  branch: string
  activity: Activity
  attachable: boolean
  tmux: string | null
  stale: boolean
  stopped?: string | null
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
