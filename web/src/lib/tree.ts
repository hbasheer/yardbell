import type { Machine, Project, Session, YardbellState } from './state'

export type Status = 'blocked' | 'error' | 'done' | 'working' | 'idle' | ''

const RANK: Record<string, number> = { blocked: 0, error: 0, done: 1, working: 2, idle: 3 }
const RATED = 85

export const WORD: Record<string, string> = { blocked: 'needs you', error: 'stopped', done: 'done', working: 'working', idle: 'idle' }

export const keyOf = (s: Session) => `${s.machine}/${s.tmux}`
export const tail = (path?: string) =>
  String(path ?? '')
    .split('/')
    .filter(Boolean)
    .pop() || String(path ?? '')
export const short = (path?: string) => String(path ?? '').replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, '~')

export function statusOf(s: Session): Status {
  if (s.stale) return ''
  if (s.activity === 'blocked') return 'blocked'
  if (s.activity === 'active') return 'working'
  if (s.stopped) return 'error'
  return 'idle'
}

export function worst(states: Status[]): Status {
  return states.filter(Boolean).sort((a, b) => RANK[a] - RANK[b])[0] || ''
}

export function memPct(m: Machine): number | null {
  const h = m.health
  return m.up && h && h.mem_total_kb ? Math.round(((h.mem_used_kb ?? 0) / h.mem_total_kb) * 100) : null
}

export function machineTone(m: Machine): 'ok' | 'warn' | 'bad' {
  if (!m.up) return 'bad'
  const h = m.health
  const limit = m.up && h && h.limit_kb ? Math.round(((h.limit_used_kb ?? 0) / h.limit_kb) * 100) : null
  return Math.max(memPct(m) ?? 0, limit ?? 0) >= RATED ? 'warn' : 'ok'
}

export type Line = { machine: string; folder: string; path: string; branch: string; pull: Session['pull']; sessions: Session[]; status: Status }
export type ProjectNode = Project & { lines: Line[]; live: Session[]; count: number; status: Status }
export type MachineNode = Machine & { projects: ProjectNode[]; other: Session[]; count: number; mem: number | null; tone: 'ok' | 'warn' | 'bad' }

const liveSessions = (state: YardbellState) => (state.sessions || []).filter((s) => s.tmux && (s.attachable || s.stale))

// A project's own checkout comes first, then its worktrees and other folders by name.
function linesOf(p: Project, mine: Session[]): Line[] {
  const lines = new Map<string, Line>()
  for (const s of mine) {
    const folder = s.folder || ''
    if (!lines.has(folder)) lines.set(folder, { machine: s.machine, folder, path: s.path || '', branch: '', pull: null, sessions: [], status: '' })
    const line = lines.get(folder)!
    line.sessions.push(s)
    line.branch ||= s.branch || ''
    line.pull ||= s.pull || null
  }
  const label = (l: Line) => l.branch || tail(l.folder)
  return [...lines.values()]
    .map((l) => ({ ...l, status: worst(l.sessions.map(statusOf)) }))
    .sort((a, b) => Number(b.path === p.path) - Number(a.path === p.path) || label(a).localeCompare(label(b)))
}

export function buildTree(state: YardbellState): MachineNode[] {
  const sessions = liveSessions(state)
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const taken = new Set<Session>()
  const projects: ProjectNode[] = (state.projects || []).map((p) => {
    const mine = (p.sessions || []).map((id) => byId.get(id)).filter((s): s is Session => Boolean(s) && !taken.has(s!))
    mine.forEach((s) => taken.add(s))
    return { ...p, lines: linesOf(p, mine), live: mine, count: mine.filter((s) => !s.stale).length, status: worst(mine.map(statusOf)) }
  })
  const machines = [...(state.machines || [])]
  for (const s of sessions) if (!machines.some((m) => m.name === s.machine)) machines.push({ name: s.machine, up: true })
  return machines
    .map((m, i) => ({ m, i }))
    .sort((a, b) => Number(b.m.up) - Number(a.m.up) || a.i - b.i)
    .map(({ m }) => {
      const own = projects.filter((p) => p.machine === m.name)
      const other = sessions.filter((s) => s.machine === m.name && !taken.has(s))
      const all = [...own.flatMap((p) => p.live), ...other]
      return { ...m, projects: own, other, count: all.filter((s) => !s.stale).length, mem: memPct(m), tone: machineTone(m) }
    })
}

export function agentName(s: Session, agents: YardbellState['agents']): string {
  const agent = agents.find((a) => a.name === s.agent)?.label || s.agent || s.tmux || ''
  return s.ticket && s.ticket !== '-' ? `${s.ticket} · ${agent}` : agent
}
