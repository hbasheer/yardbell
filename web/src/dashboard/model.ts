/* eslint-disable @typescript-eslint/no-explicit-any */
export type PullInfo = {
  number: number
  url: string
  state: string
  forge?: string
  title?: string
  draft?: boolean
  ci?: string
  failed?: string[]
  mergeable?: string
  review?: string
  base?: string
  head?: string
}
export type Port = { service: string; local?: number; remote: number; status: string; url?: string }
export type Setup = { ok: boolean; timed_out?: boolean; command: string; path: string; seconds: number; exit?: number | null; output?: string; log?: string }
export type Sess = {
  id: string
  machine: string
  agent: string
  pid?: number
  folder: string
  ticket: string
  branch: string
  activity: string
  attachable: boolean
  tmux: string | null
  stale: boolean
  stopped?: string
  resets?: string
  ports: Port[]
  pull?: PullInfo | null
  pull_why?: string
  review?: any
  setup?: Setup
  path: string
  worktree?: boolean
}
export type Ended = { id: string; machine: string; folder: string; ticket: string; branch?: string; agent: string; path?: string; worktree?: boolean }
export type Health = {
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
export type Mach = {
  name: string
  up: boolean
  reason?: string | null
  last_seen?: string
  local?: boolean
  health?: Health | null
  accounts?: { name: string; kb: number; containers_kb?: number; you?: boolean }[]
  mesh_on?: boolean
}
export type Problem = { key: string; title: string; detail: string; link: string; since: string }
export type Mesh = { label: string; on: boolean; can_turn_on?: boolean; hint?: string | null }
export type DashState = {
  machines: Mach[]
  sessions: Sess[]
  ended: Ended[]
  agents: { name: string; label: string }[]
  default_agent?: string
  host_terminal?: string
  mesh?: Mesh
  problems?: Problem[]
  folders?: { machine: string; label: string }[]
}

export const RATED = 85
export const gb = (kb: number) => (kb / 1048576).toFixed(1)
export const short = (p?: string) => String(p ?? '').replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, '~')
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function memPct(m: Mach) {
  const h = m.health
  return m.up && h && h.mem_total_kb ? Math.round((h.mem_used_kb / h.mem_total_kb) * 100) : null
}
export function limitPct(m: Mach) {
  const h = m.health
  return m.up && h && h.limit_kb ? Math.round((h.limit_used_kb / h.limit_kb) * 100) : null
}
// An account's own memory limit can run out on a machine with plenty free, so it counts too.
export function tone(m: Mach): 'ok' | 'warn' | 'bad' {
  if (!m.up) return 'bad'
  return Math.max(memPct(m) ?? 0, limitPct(m) ?? 0) >= RATED ? 'warn' : 'ok'
}
export function toneWord(m: Mach) {
  const t = tone(m)
  if (t !== 'warn') return t === 'bad' ? 'down' : 'connected'
  const limit = limitPct(m)
  return limit !== null && limit > (memPct(m) ?? 0) ? `your memory limit at ${limit}%` : `memory at ${memPct(m)}%`
}
export function order(machines: Mach[]) {
  // Machines you can work on come first; one that is down keeps its place at the end, its sessions folded.
  const rank = (m: Mach) => (m.up ? (tone(m) === 'warn' ? 0 : 1) : 2)
  return [...machines].sort((a, b) => rank(a) - rank(b))
}

// last_seen is the server's clock as HH:MM.
export function agoClock(hhmm?: string) {
  if (!hhmm) return ''
  const [h, m] = hhmm.split(':').map(Number)
  const now = new Date()
  let mins = now.getHours() * 60 + now.getMinutes() - (h * 60 + m)
  if (mins < 0) mins += 24 * 60
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  return `${Math.floor(mins / 60)} h ago`
}

export function lasted(since: string) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 60000))
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h`
}

export function connection(m: Mach, mesh?: Mesh) {
  if (m.up) {
    const load = m.health ? ` · load ${Number(m.health.load1).toFixed(1)}${m.health.cpus ? ` / ${m.health.cpus} CPUs` : ''}` : ''
    const how = m.local ? 'This machine' : m.mesh_on === false ? 'Connected over LAN, VPN off' : 'Connected'
    return `${how}${load}`
  }
  if (m.reason === 'no mesh') return mesh?.on === false ? 'Unreachable: host VPN off' : 'Not on the mesh (VPN off or asleep)'
  const reason = (m.reason || 'checking').replace(/^ssh\b/, 'SSH')
  const seen = m.last_seen ? ` · last seen ${agoClock(m.last_seen)}` : ''
  return `${reason[0].toUpperCase()}${reason.slice(1)}${seen}`
}

export function portTone(status: string) {
  if (status === 'tunnel up' || status === 'running') return 'ok'
  if (status === 'app not running' || status === 'not forwardable') return 'warn'
  return 'bad'
}

// One word for a pull request, the most urgent first: what failed or cannot merge, then what a
// reviewer asked for, then how far CI got.
export function pullStatus(p: PullInfo): { word: string; tone: string } {
  if (p.state === 'merged') return { word: 'merged', tone: 'done' }
  if (p.state === 'closed') return { word: 'closed', tone: '' }
  if (p.ci === 'failing') return { word: 'CI failing', tone: 'bad' }
  if (p.mergeable === 'conflicting') return { word: 'conflicts', tone: 'bad' }
  if (p.review === 'changes_requested') return { word: 'changes requested', tone: 'warn' }
  if (p.ci === 'pending') return { word: 'CI running', tone: 'pending' }
  if (p.review === 'approved') return { word: 'approved', tone: 'ok' }
  if (p.ci === 'passing') return { word: 'CI passing', tone: 'ok' }
  return { word: p.draft ? 'draft' : 'open', tone: '' }
}

// GitLab numbers a merge request !12 where GitHub writes #12.
export const ref = (p: PullInfo) => `${p.forge === 'gitlab' ? '!' : '#'}${p.number}`
export const noun = (p: PullInfo) => (p.forge === 'gitlab' ? 'Merge request' : 'Pull request')

function details(p: PullInfo) {
  if (p.state === 'merged' || p.state === 'closed') return [p.state === 'merged' ? 'Merged' : 'Closed']
  const parts: string[] = []
  const ci = ({ failing: p.forge === 'gitlab' ? 'Pipeline failing' : 'CI failing', pending: 'CI running', passing: 'CI passing' } as Record<string, string>)[p.ci || '']
  if (ci) parts.push(p.ci === 'failing' && p.failed?.length ? `${ci} on ${p.failed.join(', ')}` : ci)
  if (p.mergeable === 'conflicting') parts.push(p.base ? `Merge conflicts with ${p.base}` : 'Merge conflicts')
  const review = ({ approved: 'Approved', changes_requested: 'Changes requested', review_required: 'Review required' } as Record<string, string>)[p.review || '']
  if (review) parts.push(review)
  return parts
}

export function describe(p: PullInfo) {
  const head = `${noun(p)} ${ref(p)}${p.title ? `: ${p.title}` : ''}${p.draft ? ' (draft)' : ''}`
  return `${[head, ...details(p)].join('. ')}.`
}

export type Mark = { word: string; tone: string; href: string; title: string }
// Where the newest review of a session's branch stands, shown beside its pull request badge.
export function reviewMark(s: Sess): Mark | null {
  const r = s.review
  if (!r) return null
  const href = `/dispatch?c=${encodeURIComponent(r.conversation)}`
  const head = s.pull?.head
  if (['ready', 'changes'].includes(r.state) && head && r.commit && r.commit !== head) {
    return { word: 'reviewed an older commit', tone: '', href, title: `The newest review was of ${r.commit.slice(0, 7)}. ${noun(s.pull!)} ${ref(s.pull!)} is now at ${head.slice(0, 7)}.` }
  }
  switch (r.state) {
    case 'asking':
      return { word: 'review waiting', tone: 'pending', href, title: 'A review of this branch waits for you in Dispatch.' }
    case 'reviewing':
      return { word: 'reviewing', tone: 'pending', href, title: 'A reviewer is reading this branch and running its tests.' }
    case 'ready':
      return { word: 'review: ready', tone: 'ok', href, title: 'The newest review found nothing that needs changing.' }
    default: {
      const n = r.findings || 0
      const word = n ? `${n} review ${n === 1 ? 'finding' : 'findings'}` : 'review: changes needed'
      const t = ({ high: 'bad', medium: 'warn', low: '' } as Record<string, string>)[r.top] ?? 'warn'
      return { word, tone: t, href, title: `The newest review asks for changes${r.top ? `; the most serious is ${r.top}` : ''}.` }
    }
  }
}

export const reviewable = (s: Sess) => Boolean(s.tmux && s.pull?.state === 'open' && !s.stale)

// GitHub can take a moment to say whether a pull request merges cleanly, so only a known conflict
// keeps an approved, green one out of Ready to merge.
export const ready = (p: PullInfo) => !p.draft && p.review === 'approved' && (p.ci === 'passing' || p.ci === 'none') && p.mergeable !== 'conflicting'

export function mergeText(p: PullInfo) {
  return {
    title: `Merge ${ref(p)}?`,
    body: `${p.title ? `${p.title}. ` : ''}It merges into ${p.base || 'its base branch'} on ${p.forge === 'gitlab' ? 'GitLab' : 'GitHub'}, the way Settings says, and only if nothing was pushed to the ${noun(p).toLowerCase()} since this page showed it. The branch is kept.`
  }
}

export const canMerge = (s: Sess) => Boolean(s.pull && s.pull.state === 'open' && s.tmux && !s.stale && ready(s.pull))

export const LANES = [
  { key: 'needs', title: 'Needs you', help: 'Waiting for your answer, stopped on an error, or its pull request failed CI, has conflicts or has changes requested' },
  { key: 'working', title: 'Working', help: 'The agent is working' },
  { key: 'review', title: 'In review', help: 'Its pull request is open: CI is running, or it waits for a review' },
  { key: 'ready', title: 'Ready to merge', help: 'Approved, CI green and no merge conflicts' },
  { key: 'idle', title: 'Idle', help: 'No open pull request' }
] as const
export type LaneKey = (typeof LANES)[number]['key']

const needsFix = (p: PullInfo) => p.ci === 'failing' || p.mergeable === 'conflicting' || p.review === 'changes_requested'

// A working agent is left to work, whatever its pull request says; an idle one is placed by what
// its pull request needs next.
export function lane(s: Sess): LaneKey {
  if (s.activity === 'blocked' || s.stopped) return 'needs'
  if (s.activity === 'active') return 'working'
  const p = s.pull
  if (!p || p.state !== 'open') return 'idle'
  if (needsFix(p)) return 'needs'
  if (ready(p)) return 'ready'
  return 'review'
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

export const enc = encodeURIComponent
