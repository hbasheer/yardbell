import { ApiClient } from '../api/client'
import type { PairedServer } from '../servers/store'

export type DispatchRule = { action: string; machine: string; folder: string; approval: string }

export type DispatchSettings = {
  instructions?: string
  agent?: string
  runs_on?: string
  model?: string
  codex_model?: string
  approval?: string
  rules?: DispatchRule[]
}

export type PhoneSettings = {
  app_connected?: boolean
  wait_minutes: number
  agent_waiting: boolean
  session_ended: boolean
  machines: boolean
  memory: boolean
  pipeline_waiting: boolean
  pipeline_finished: boolean
  proposals: boolean
  dispatch: boolean
  pull_ci_failed: boolean
  pull_conflicts: boolean
  pull_ready: boolean
  pull_merged: boolean
  pull_closed: boolean
  limit_reset: boolean
}

export type PhoneSettingsChange = Partial<Omit<PhoneSettings, 'app_connected'>>

export type ServerSettings = {
  dispatch?: DispatchSettings
  phone?: PhoneSettings
  dispatch_runs_on?: string[]
  codex_models?: string[]
  agents?: { name: string; label: string }[]
  default_agent?: string
  machines?: { name: string; local?: boolean }[]
}

export type DispatchChange = Partial<DispatchSettings> | ((current: DispatchSettings) => Partial<DispatchSettings>)

export type TriggerDefinition = {
  name: string
  task: string
  enabled: boolean
  schedule?: string
  linear?: { assigned?: boolean; states?: string[] }
  github?: { assigned?: boolean; review_requested?: boolean }
}

export type TriggerLast = { at: string; outcome: string; text: string; conversation?: string }

export type TriggerState = {
  trigger: TriggerDefinition
  kind?: string
  describe?: string
  next?: string | null
  last?: TriggerLast | null
  note?: string
  problem?: string
  checked?: string | null
  busy?: boolean
}

export type TriggerList = { zone?: string; now?: string; triggers: TriggerState[]; tasks?: string[] }

export type TriggerRun = { conversation?: string | null; text?: string }

export type MemoryChangeKind = 'add' | 'replace' | 'forget'

export type MemoryRecord = { change: MemoryChangeKind; old?: string; entry?: string; at: string; by: string; reason?: string }

export type DispatchMemory = {
  entries: string[]
  bytes: number
  max_bytes: number
  max_entry_chars?: number
  omitted: number
  file: string
  history: MemoryRecord[]
  error?: string | null
}

export type MemoryChange = { change: MemoryChangeKind; old?: string; entry?: string; reason?: string }

const client = (server: PairedServer) => new ApiClient(server)

export function getServerSettings(server: PairedServer): Promise<ServerSettings> {
  return client(server).get('/api/settings')
}

export async function setDispatchSettings(server: PairedServer, change: DispatchChange): Promise<ServerSettings> {
  const api = client(server)
  const current = await api.get<ServerSettings>('/api/settings')
  const d = current.dispatch ?? {}
  await api.post('/api/settings/dispatch', {
    instructions: d.instructions ?? '',
    agent: d.agent ?? '',
    runs_on: d.runs_on ?? 'claude',
    model: d.model ?? '',
    codex_model: d.codex_model ?? '',
    ...(d.approval ? { approval: d.approval } : {}),
    rules: d.rules ?? [],
    ...(typeof change === 'function' ? change(d) : change)
  })
  return api.get<ServerSettings>('/api/settings')
}

export async function setPhoneSettings(server: PairedServer, change: PhoneSettingsChange): Promise<PhoneSettings> {
  const api = client(server)
  const current = (await api.get<ServerSettings>('/api/settings')).phone
  if (!current) throw new Error('This server did not send its phone notification settings')
  const { app_connected: _connected, ...saved } = current
  await api.post('/api/settings/phone', { ...saved, ...change })
  const fresh = (await api.get<ServerSettings>('/api/settings')).phone
  return fresh ?? { ...saved, ...change }
}

export async function installedAgents(server: PairedServer, machine: string): Promise<string[]> {
  const found = await client(server).get<{ installed: string[] }>(`/machines/${encodeURIComponent(machine)}/agents`)
  return found.installed
}

export function getTriggers(server: PairedServer): Promise<TriggerList> {
  return client(server).get('/api/triggers')
}

export function setTriggerEnabled(server: PairedServer, name: string, enabled: boolean): Promise<TriggerList> {
  return client(server).post('/api/triggers/enable', { name, enabled })
}

export function runTrigger(server: PairedServer, name: string): Promise<TriggerRun> {
  return client(server).post('/api/triggers/run', { name })
}

export function getMemory(server: PairedServer): Promise<DispatchMemory> {
  return client(server).get('/dispatch/memory')
}

export function changeMemory(server: PairedServer, change: MemoryChange): Promise<DispatchMemory> {
  return client(server).post('/dispatch/memory', change)
}
