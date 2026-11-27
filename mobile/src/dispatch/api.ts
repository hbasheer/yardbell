import { fetch as streamingFetch } from 'expo/fetch'
import { ApiClient, ServerError, SignedOutError, UnreachableError } from '../api/client'
import type { PairedServer } from '../servers/store'
import { finishStream, parseChunk } from './stream'
import type {
  ActionEvent,
  AskRequest,
  Conversation,
  ConversationSummary,
  Decision,
  DispatchEvent,
  PromptDiff,
  PromptHistory,
  ReviewEvent,
  RunsOn,
  SavedPrompt,
  SessionEvent,
  StreamLine
} from './types'

const POLL_MS = 2000
const ASK_CONNECT_MS = 60_000
const TRANSCRIBE_TIMEOUT_MS = 120_000

const client = (server: PairedServer) => new ApiClient(server)
const conversationPath = (id: string, rest = '') => `/dispatch/conversations/${encodeURIComponent(id)}${rest}`

export const isAlreadyDecided = (error: unknown): boolean => error instanceof ServerError && error.status === 409

export function listConversations(server: PairedServer): Promise<ConversationSummary[]> {
  return client(server).get('/dispatch/conversations')
}

export function getConversation(server: PairedServer, id: string): Promise<Conversation> {
  return client(server).get(conversationPath(id))
}

export function attachmentSource(server: PairedServer, id: string, file: string) {
  return {
    uri: `${server.address}${conversationPath(id, `/attachments/${encodeURIComponent(file)}`)}`,
    headers: { Authorization: `Bearer ${server.token}` }
  }
}

export function stopConversation(server: PairedServer, id: string): Promise<{ ok: boolean }> {
  return client(server).post(conversationPath(id, '/stop'), {})
}

export function deleteConversation(server: PairedServer, id: string): Promise<{ ok: boolean }> {
  return client(server).post(conversationPath(id, '/delete'), {})
}

export function clearConversations(server: PairedServer): Promise<{ kept: number }> {
  return client(server).post('/dispatch/clear', {})
}

export function getRunsOn(server: PairedServer): Promise<RunsOn> {
  return client(server).get('/dispatch/runs-on')
}

export async function transcribe(server: PairedServer, audio: Blob, mime: string): Promise<{ text: string }> {
  let response: Response
  try {
    response = await fetch(`${server.address}/dispatch/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': mime, Accept: 'application/json' },
      body: audio,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)
    })
  } catch {
    throw new UnreachableError(server.address)
  }
  return readReply<{ text: string }>(response)
}

async function readReply<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => undefined)
  const message =
    body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `The server refused the request (${response.status})`
  if (response.status === 401) throw new SignedOutError(message)
  if (!response.ok) throw new ServerError(message, response.status)
  return body as T
}

export type AskHandlers = {
  signal?: AbortSignal
  onConversation?: (id: string) => void
  onEvent: (event: DispatchEvent) => void
}

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

export async function ask(
  server: PairedServer,
  request: AskRequest,
  handlers: AskHandlers,
  fetchImpl: FetchImpl = streamingFetch as unknown as FetchImpl
): Promise<void> {
  const connect = new AbortController()
  const timer = setTimeout(() => connect.abort(), ASK_CONNECT_MS)

  let response: Response
  try {
    response = await fetchImpl(`${server.address}/dispatch/ask`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${server.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson'
      },
      body: JSON.stringify(request),
      signal: handlers.signal ? anySignal([connect.signal, handlers.signal]) : connect.signal
    })
  } catch {
    if (handlers.signal?.aborted) return
    throw new UnreachableError(server.address)
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) await readReply(response)
  if (!response.body) throw new ServerError('The server sent no reply', response.status)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let rest = ''
  const deliver = (line: StreamLine) => {
    if (line.role === 'conversation') handlers.onConversation?.(line.id)
    else if (line.role !== 'done') handlers.onEvent(line)
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const parsed = parseChunk(rest, decoder.decode(value, { stream: true }))
      rest = parsed.rest
      parsed.lines.forEach(deliver)
    }
    finishStream(rest + decoder.decode()).forEach(deliver)
  } catch (error) {
    if (handlers.signal?.aborted) return
    throw error
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller.signal
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

export type FollowOptions = {
  signal?: AbortSignal
  intervalMs?: number
  onUpdate?: (conversation: Conversation) => void
}

export async function followTurn(
  server: PairedServer,
  id: string,
  options: FollowOptions = {}
): Promise<Conversation | null> {
  const { signal, intervalMs = POLL_MS, onUpdate } = options
  while (!signal?.aborted) {
    try {
      const conversation = await getConversation(server, id)
      if (signal?.aborted) return null
      onUpdate?.(conversation)
      if (!conversation.busy) return conversation
    } catch (error) {
      if (!(error instanceof UnreachableError)) throw error
    }
    await pause(intervalMs, signal)
  }
  return null
}

export type DecideBody = { decision: Decision; input?: Record<string, unknown>; again?: boolean }

export function decideStep(server: PairedServer, id: string, step: string, body: DecideBody): Promise<ActionEvent> {
  return client(server).post(conversationPath(id, `/actions/${encodeURIComponent(step)}`), body)
}

export function decideAll(server: PairedServer, id: string, decision: Decision): Promise<ActionEvent[]> {
  return client(server).post(conversationPath(id, '/actions'), { decision })
}

export function decideGroup(server: PairedServer, id: string, group: string, decision: Decision): Promise<ActionEvent[]> {
  return client(server).post(conversationPath(id, `/groups/${encodeURIComponent(group)}`), { decision })
}

export function answerSession(server: PairedServer, id: string, card: number, key: string): Promise<SessionEvent> {
  return client(server).post(conversationPath(id, '/answers'), { card, key })
}

export function requestReview(server: PairedServer, id: string, card: number, child?: number): Promise<ActionEvent> {
  return client(server).post(conversationPath(id, '/reviews'), child === undefined ? { card } : { card, child })
}

export type ReviewDecision =
  | { decision: 'send'; findings: number[]; to?: string }
  | { decision: 'start'; findings?: number[] }
  | { decision: 'dismiss' }

export function decideReview(
  server: PairedServer,
  id: string,
  card: number,
  body: ReviewDecision
): Promise<ReviewEvent | { card: number; step: ActionEvent }> {
  return client(server).post(conversationPath(id, `/reviews/${card}`), body)
}

export function sendToSession(
  server: PairedServer,
  id: string,
  card: number,
  text?: string
): Promise<{ card: number; step: ActionEvent }> {
  return client(server).post(conversationPath(id, '/pulls'), text === undefined ? { card } : { card, text })
}

export function reviewSession(
  server: PairedServer,
  machine: string,
  name: string
): Promise<{ conversation: string; step: ActionEvent }> {
  return client(server).post('/dispatch/reviews', { machine, name })
}

export type ScanRequest = {
  conversation?: string
  card?: number
  machine: string
  folder: string
  inside: string
  path: string
  branch: string
  kind: 'dead_code' | 'test_gaps' | 'security'
}

export function startScan(server: PairedServer, body: ScanRequest): Promise<{ conversation: string; step: ActionEvent }> {
  return client(server).post('/dispatch/scans', body)
}

export function listPrompts(server: PairedServer): Promise<SavedPrompt[]> {
  return client(server).get('/dispatch/tasks')
}

export function savePrompt(
  server: PairedServer,
  prompt: { name: string; text: string; replacing?: string | null }
): Promise<SavedPrompt[]> {
  return client(server).post('/dispatch/tasks', prompt)
}

export function deletePrompt(server: PairedServer, name: string): Promise<SavedPrompt[]> {
  return client(server).post('/dispatch/tasks/delete', { name })
}

export function restorePrompts(server: PairedServer): Promise<SavedPrompt[]> {
  return client(server).post('/dispatch/tasks/restore', {})
}

export function promptHistory(server: PairedServer, name: string): Promise<PromptHistory> {
  return client(server).get(`/dispatch/tasks/history?name=${encodeURIComponent(name)}`)
}

export function promptDiff(server: PairedServer, name: string, from: number, to: number): Promise<PromptDiff> {
  return client(server).get(`/dispatch/tasks/diff?name=${encodeURIComponent(name)}&from=${from}&to=${to}`)
}

export function restorePromptVersion(
  server: PairedServer,
  name: string,
  version: number
): Promise<{ tasks: SavedPrompt[]; history: PromptHistory }> {
  return client(server).post('/dispatch/tasks/versions/restore', { name, version })
}

export type DispatchSettings = {
  instructions?: string
  agent?: string
  runs_on?: string
  model?: string
  codex_model?: string
  approval?: string
  rules?: unknown[]
}

export async function setDispatchSettings(server: PairedServer, change: Partial<DispatchSettings>): Promise<void> {
  const api = client(server)
  const current = await api.get<{ dispatch?: DispatchSettings }>('/api/settings')
  const d = current.dispatch ?? {}
  await api.post('/api/settings/dispatch', {
    instructions: d.instructions ?? '',
    agent: d.agent ?? '',
    runs_on: d.runs_on ?? 'claude',
    model: d.model ?? '',
    codex_model: d.codex_model ?? '',
    ...(d.approval ? { approval: d.approval } : {}),
    rules: d.rules ?? [],
    ...change
  })
}

export function getDispatchSettings(server: PairedServer): Promise<{ dispatch?: DispatchSettings }> {
  return client(server).get('/api/settings')
}
