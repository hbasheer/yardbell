/* eslint-disable @typescript-eslint/no-explicit-any */
export type Convo = { id: string; title: string; updated: string; busy?: boolean; waiting?: number; trigger?: string }
export type Task = { name: string; text: string; version: number; builtin?: boolean; customised?: boolean; hidden?: boolean }
export type RunsOn = { runs_on: string; agents?: Record<string, { label?: string; model?: string }>; voice_input?: boolean; voice_mode?: string }
export type Event = { role: string; [k: string]: any }
export type Trigger = { name: string; task?: string; version?: number; what?: string; at?: string; slot?: string; url?: string }
export type Tracked = { machine: string; name: string }
export type Conversation = { id: string; events: Event[]; updated: string; busy: boolean; backend?: string; trigger?: Trigger; sessions?: Tracked[] }

export const CLAUDE_MODELS: Record<string, string> = { fable: 'Fable 5.2', opus: 'Opus 5.5', sonnet: 'Sonnet 5.5', haiku: 'Haiku 5.5' }

export const LABELS: Record<string, string> = {
  list_machines: 'Checked machines',
  list_sessions: 'Checked sessions',
  list_folders: 'Looked for the repository',
  read_session: 'Read a session'
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  if (res.status === 401) {
    location.href = '/login'
    throw new Error('logged out')
  }
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`)
  return out as T
}

export function ago(stamp: string) {
  const secs = Math.max(0, (Date.now() - Date.parse(stamp)) / 1000)
  if (secs < 60) return 'just now'
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`
  return new Date(stamp).toLocaleDateString()
}

export const short = (p: string) => String(p ?? '').replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, '~')
export const folderOf = (p: string) =>
  String(p ?? '')
    .replace(/\/+$/, '')
    .split('/')
    .pop() || p
export const termUrl = (machine: string, name: string) => `/term/${encodeURIComponent(machine)}/${encodeURIComponent(name)}`

export function target(input: any) {
  const where = [input?.machine, input?.folder || input?.path, input?.branch].filter(Boolean)
  return where.length ? ` · ${where.join(' · ')}` : ''
}

// A question with a preview draws the preview box beside the choices; older saved conversations
// still carry the box, so it is cut here too.
export const optionLabel = (label: string) =>
  String(label)
    .split(/ {3}|[─-╿]/)[0]
    .trim() || label

// Rules drawn across the terminal carry no text, and the agent's own left margin only pushes lines right.
export function readable(screen: string) {
  const lines = String(screen)
    .split('\n')
    .filter((l) => !/^[\s─-╿]+$/.test(l) || !l.trim())
    .map((l) => l.replace(/\s*[│┃]?\s*$/, ''))
    .filter((l, i, all) => l.trim() || (i > 0 && all[i - 1].trim()))
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length)
  const cut = indents.length ? Math.min(...indents) : 0
  return lines
    .map((l) => l.slice(cut))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
}

export function serverTime(stamp?: string) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(stamp || '')
  if (!m) return ''
  const day = new Date(`${m[1]}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
  return `${day}, ${m[2]}`
}

export type Chip = { name: string; input: any; result: Event | null }
export type Block = { kind: 'tools'; key: number; chips: Chip[] } | { kind: string; key: number; event: Event }

// Tool calls in a row share one line of chips, and each result lands on the first chip of its name
// still waiting for one. Steps that change something are cards of their own.
export function blocks(list: Event[], steps: any): Block[] {
  const out: Block[] = []
  const waiting: Chip[] = []
  const legacy: any[] = []
  let group: { kind: 'tools'; key: number; chips: Chip[] } | null = null
  list.forEach((e, i) => {
    if ((e.role === 'tool' || e.role === 'tool_result') && steps?.CHANGING.has(e.name)) {
      let step = e.role === 'tool_result' ? legacy.find((s) => s.tool === e.name && !s.result) : null
      if (!step) {
        step = steps.legacyStep(e.name, e.role === 'tool' ? e.input : null)
        legacy.push(step)
        out.push({ kind: 'action', key: i, event: step })
      }
      if (e.role === 'tool_result') steps.legacyResult(step, e)
      group = null
      return
    }
    if (e.role === 'tool' || e.role === 'tool_result') {
      let chip = e.role === 'tool_result' ? waiting.find((c) => c.name === e.name && !c.result) : null
      if (!chip) {
        if (!group) out.push((group = { kind: 'tools', key: i, chips: [] }))
        chip = { name: e.name, input: e.role === 'tool' ? e.input : null, result: null }
        group.chips.push(chip)
        waiting.push(chip)
      }
      if (e.role === 'tool_result') chip.result = e
      return
    }
    group = null
    if (e.role === 'action' && e.group) return
    out.push({ kind: e.role, key: i, event: e })
  })
  return out
}
