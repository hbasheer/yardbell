import { ApiClient } from '../api/client'
import type { PairedServer } from '../servers/store'
import type { BriefRun, ConnectorInfo, Definition, Outcome, Run, RunCounts } from './model'

export type ListedPipeline = { definition: Definition; runs: RunCounts; problem?: string }

export type PipelineList = {
  pipelines: ListedPipeline[]
  templates: string[]
  settings: Record<string, unknown>
  machines: string[]
  agents: string[]
  agents_without_tokens?: string[]
  default_agent: string
  mcp_servers: string[]
  gitlab_hosts: string[]
  connectors: ConnectorInfo[]
}

export type PipelineVersion = { version: number; saved: string; definition: Definition }

export type PipelineHistory = { history: PipelineVersion[]; current: number }

export type OpenTicket = { linear_id: string; id: string; title: string; url: string; state: string; running_in: string[] }

export type TranscriptItem = {
  kind: 'prompt' | 'agent' | 'tool'
  text?: string
  at?: string
  name?: string
  input?: string
  result?: string
  failed?: boolean
}

export type StepTranscript = {
  available: boolean
  why?: string
  path?: string
  machine?: string
  transcript?: { dropped?: number; skipped?: number; cut?: boolean; files: string[]; items: TranscriptItem[] }
}

export type DiagramRef = { machine: string; folder: string; dir: string }

export type RunStart = { tickets?: string[]; prs?: string[]; diagram?: DiagramRef }

const client = (server: PairedServer) => new ApiClient(server)
const pipelinePath = (id: string, rest = '') => `/api/pipelines/${encodeURIComponent(id)}${rest}`
const runPath = (id: string, rest = '') => `/api/runs/${encodeURIComponent(id)}${rest}`

export function listPipelines(server: PairedServer): Promise<PipelineList> {
  return client(server).get('/api/pipelines')
}

export function getPipeline(server: PairedServer, id: string): Promise<Definition> {
  return client(server).get(pipelinePath(id))
}

export function setPipelineEnabled(server: PairedServer, id: string, enabled: boolean): Promise<Definition> {
  return client(server).post(pipelinePath(id, '/enabled'), { enabled })
}

export function pipelineHistory(server: PairedServer, id: string): Promise<PipelineHistory> {
  return client(server).get(pipelinePath(id, '/history'))
}

export function pipelineRuns(server: PairedServer, id: string): Promise<{ runs: Run[] }> {
  return client(server).get(pipelinePath(id, '/runs'))
}

export function startRuns(server: PairedServer, id: string, body: RunStart): Promise<{ runs: Run[] }> {
  return client(server).post(pipelinePath(id, '/runs'), body)
}

export function openTickets(server: PairedServer): Promise<{ tickets: OpenTicket[] }> {
  return client(server).get('/api/pipelines/tickets')
}

export function listDiagrams(server: PairedServer): Promise<{ diagrams: DiagramRef[] }> {
  return client(server).get('/api/diagrams')
}

export function clearEndedRuns(server: PairedServer, id: string): Promise<{ deleted: string[] }> {
  return client(server).post(pipelinePath(id, '/clear-runs'), {})
}

export function listRuns(server: PairedServer): Promise<{ runs: Run[] }> {
  return client(server).get('/api/runs')
}

export function briefRuns(server: PairedServer, state?: string): Promise<{ runs: BriefRun[] }> {
  const filter = state ? `&state=${encodeURIComponent(state)}` : ''
  return client(server).get(`/api/runs?brief=1${filter}`)
}

export function deleteRun(server: PairedServer, id: string): Promise<{ deleted: string }> {
  return client(server).delete(runPath(id))
}

export function answerRun(server: PairedServer, id: string, text: string): Promise<Run> {
  return client(server).post(runPath(id, '/answer'), { text })
}

export function retryRun(server: PairedServer, id: string): Promise<Run> {
  return client(server).post(runPath(id, '/retry'), {})
}

export function acceptTool(server: PairedServer, id: string): Promise<Run> {
  return client(server).post(runPath(id, '/accept-tool'), {})
}

export function dropRun(server: PairedServer, id: string): Promise<Run> {
  return client(server).post(runPath(id, '/drop'), {})
}

export function continueRun(server: PairedServer, id: string, outcome: Exclude<Outcome, 'needs_you'>): Promise<Run> {
  return client(server).post(runPath(id, '/continue'), { outcome })
}

export function setTokenLimit(server: PairedServer, id: string, limit: number): Promise<Run> {
  return client(server).post(runPath(id, '/token-limit'), { limit })
}

export function stopRunSession(server: PairedServer, id: string, name: string): Promise<{ ok: boolean }> {
  return client(server).post(runPath(id, '/stop-session'), { name })
}

export function stepTranscript(server: PairedServer, id: string, step: string): Promise<StepTranscript> {
  return client(server).get(runPath(id, `/steps/${encodeURIComponent(step)}/transcript`))
}
