import type { PairedServer } from '../servers/store'
import type { Connection } from './liveSocket'
import type { EndedView, MachineView, PullView, SessionView, StateView } from './types'

export type ServerState = {
  server: PairedServer
  state: StateView | undefined
  connection: Connection
}

export type ServerSession = SessionView & { serverId: string }

export type SessionStatus = 'needs-you' | 'working' | 'idle' | 'stopped'

export type SessionGroupBy = 'status' | 'machine' | 'project' | 'agent'
export type MachineGroupBy = 'project' | 'status' | 'agent'

export type SessionSection = {
  key: string
  title: string
  subtitle?: string
  sessions: ServerSession[]
}

export type FeedSection = {
  kind: 'needs-you' | 'working'
  title: string
  total: number
  shown: ServerSession[]
  more: number
}

export type MachineRowStatus = 'up' | 'down' | 'reconnecting' | 'unreachable'

export type MachineRow = {
  key: string
  serverId: string
  machine: string
  serverLabel?: string
  status: MachineRowStatus
  reason: string | null
  sessions: number
  needsYou: number
  outsideTmux: number
}

export type MachineExtras = {
  loose: ServerSession[]
  stale: ServerSession[]
  ended: EndedView[]
}

export type Project = { key: string; label: string; path: string }

export type PrState = 'open' | 'draft' | 'merged' | 'closed'
export type PrBadge = { state: PrState; label: string }

export type Siblings = { sessions: ServerSession[]; index: number }

const FEED_ROWS = 3
const RANK: Record<SessionStatus, number> = { 'needs-you': 0, working: 1, idle: 2, stopped: 3 }
const STATUS_TITLE: Record<SessionStatus, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  idle: 'Idle',
  stopped: 'Stopped'
}

export function statusOf(session: SessionView): SessionStatus {
  if (session.stopped || session.stale) return 'stopped'
  if (session.activity === 'blocked') return 'needs-you'
  if (session.activity === 'active') return 'working'
  return 'idle'
}

const base = (path: string) => path.split('/').filter(Boolean).pop() ?? path

const absolute = (path: string | undefined) => (path && path.startsWith('/') ? path : '')

// Yardbell makes worktrees in <repo>-worktrees/<name>, and the server's project grouping puts them under <repo>.
export function projectOf(session: SessionView): Project {
  const place = absolute(session.path) || absolute(session.cwd) || ''
  if (!place) {
    const label = session.folder || session.machine
    return { key: `${session.machine}:${label}`, label, path: '' }
  }
  const marker = place.indexOf('-worktrees/')
  const root = marker > 0 ? place.slice(0, marker) : place.replace(/\/+$/, '') || '/'
  return { key: `${session.machine}:${root}`, label: base(root), path: root }
}

const sessionOrder = (a: SessionView, b: SessionView) =>
  RANK[statusOf(a)] - RANK[statusOf(b)] ||
  a.folder.localeCompare(b.folder) ||
  a.branch.localeCompare(b.branch) ||
  a.id.localeCompare(b.id)

const hasTicket = (session: SessionView) => Boolean(session.ticket && session.ticket !== '-')

function matcher(query: string): (session: SessionView) => boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return () => true
  return (session) => {
    const haystack = [
      session.folder,
      session.branch,
      hasTicket(session) ? session.ticket : '',
      session.agent,
      session.machine,
      projectOf(session).label
    ]
      .join('\n')
      .toLowerCase()
    return terms.every((term) => haystack.includes(term))
  }
}

const isListed = (session: SessionView) => session.attachable && !session.stale

const isLoose = (session: SessionView) => !session.attachable && !session.stale

const owned = (server: PairedServer, sessions: SessionView[]): ServerSession[] =>
  sessions.map((s) => ({ ...s, serverId: server.id }))

const allSessions = (servers: ServerState[]): ServerSession[] =>
  servers.flatMap(({ server, state }) => owned(server, (state?.sessions ?? []).filter(isListed)))

function group(
  sessions: ServerSession[],
  keyOf: (s: ServerSession) => { key: string; title: string; subtitle?: string }
): SessionSection[] {
  const sections = new Map<string, SessionSection>()
  for (const session of sessions) {
    const { key, title, subtitle } = keyOf(session)
    if (!sections.has(key)) sections.set(key, { key, title, subtitle, sessions: [] })
    sections.get(key)!.sessions.push(session)
  }
  return [...sections.values()]
}

const urgency = (section: SessionSection) => Math.min(...section.sessions.map((s) => RANK[statusOf(s)]))

function arrange(sections: SessionSection[], bySeverity: boolean): SessionSection[] {
  for (const section of sections) section.sessions.sort(sessionOrder)
  if (!bySeverity) return sections
  return sections.sort((a, b) => urgency(a) - urgency(b) || a.title.localeCompare(b.title))
}

function sectionsFor(
  sessions: ServerSession[],
  groupBy: SessionGroupBy,
  multipleServers: boolean,
  serverLabel: (serverId: string) => string
): SessionSection[] {
  switch (groupBy) {
    case 'status': {
      const sections = group(sessions, (s) => {
        const status = statusOf(s)
        return { key: status, title: STATUS_TITLE[status] }
      })
      return arrange(sections, false).sort((a, b) => RANK[statusOf(a.sessions[0])] - RANK[statusOf(b.sessions[0])])
    }
    case 'agent':
      return arrange(
        group(sessions, (s) => ({ key: s.agent, title: s.agent })),
        true
      )
    case 'machine':
      return arrange(
        group(sessions, (s) => ({
          key: `${s.serverId}:${s.machine}`,
          title: s.machine,
          subtitle: multipleServers ? serverLabel(s.serverId) : undefined
        })),
        true
      )
    case 'project':
      return arrange(
        group(sessions, (s) => {
          const project = projectOf(s)
          return {
            key: `${s.serverId}:${project.key}`,
            title: project.label,
            subtitle: multipleServers ? `${s.machine} on ${serverLabel(s.serverId)}` : s.machine
          }
        }),
        true
      )
  }
}

export function feedSections(servers: ServerState[]): FeedSection[] {
  const live = allSessions(servers).sort(sessionOrder)
  const make = (kind: FeedSection['kind'], status: SessionStatus): FeedSection[] => {
    const sessions = live.filter((s) => statusOf(s) === status)
    if (sessions.length === 0) return []
    return [
      {
        kind,
        title: STATUS_TITLE[status],
        total: sessions.length,
        shown: sessions.slice(0, FEED_ROWS),
        more: Math.max(0, sessions.length - FEED_ROWS)
      }
    ]
  }
  return [...make('needs-you', 'needs-you'), ...make('working', 'working')]
}

function rowStatus(connection: Connection, machine: MachineView | undefined): MachineRowStatus {
  if (connection === 'unreachable') return 'unreachable'
  if (connection === 'reconnecting') return 'reconnecting'
  return machine && !machine.up ? 'down' : 'up'
}

function rowReason(status: MachineRowStatus, server: PairedServer, machine: MachineView | undefined): string | null {
  switch (status) {
    case 'unreachable':
      return `Cannot reach ${server.address}`
    case 'reconnecting':
      return `Reconnecting to ${server.address}`
    case 'down':
      return machine?.reason || 'Machine is down'
    case 'up':
      return null
  }
}

export function machineRows(servers: ServerState[]): MachineRow[] {
  const multiple = servers.length > 1
  return servers.flatMap(({ server, state, connection }) => {
    const machines: (MachineView | undefined)[] = state && state.machines.length > 0 ? state.machines : [undefined]
    return machines.map((machine) => {
      const name = machine?.name ?? server.machine
      const status = rowStatus(connection, machine)
      const mine = (state?.sessions ?? []).filter((s) => s.machine === name && isListed(s) && statusOf(s) !== 'stopped')
      const outside = (state?.sessions ?? []).filter((s) => s.machine === name && isLoose(s))
      return {
        key: `${server.id}:${name}`,
        serverId: server.id,
        machine: name,
        serverLabel: multiple ? server.machine : undefined,
        status,
        reason: rowReason(status, server, machine),
        sessions: mine.length,
        needsYou: mine.filter((s) => statusOf(s) === 'needs-you').length,
        outsideTmux: outside.length
      }
    })
  })
}

export function machineSections(
  server: ServerState,
  machine: string,
  groupBy: MachineGroupBy,
  query: string,
  showStopped = true
): SessionSection[] {
  const matches = matcher(query)
  const sessions = owned(
    server.server,
    (server.state?.sessions ?? []).filter(
      (s) => s.machine === machine && isListed(s) && matches(s) && (showStopped || statusOf(s) !== 'stopped')
    )
  )
  return sectionsFor(sessions, groupBy, false, () => '')
}

export function machineExtras(server: ServerState, machine: string, query = ''): MachineExtras {
  const matches = matcher(query)
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const mine = owned(
    server.server,
    (server.state?.sessions ?? []).filter((s) => s.machine === machine && matches(s))
  )
  const endedMatches = (e: EndedView) => {
    const haystack = [e.folder, e.branch ?? '', e.ticket ?? '', e.agent, e.machine].join('\n').toLowerCase()
    return terms.every((term) => haystack.includes(term))
  }
  return {
    loose: mine.filter(isLoose).sort(sessionOrder),
    stale: mine.filter((s) => s.stale).sort(sessionOrder),
    ended: (server.state?.ended ?? []).filter((e) => e.machine === machine && endedMatches(e))
  }
}

export function sessionsTab(servers: ServerState[], groupBy: SessionGroupBy, query: string): SessionSection[] {
  const matches = matcher(query)
  const labels = new Map(servers.map(({ server }) => [server.id, server.machine]))
  return sectionsFor(
    allSessions(servers).filter(matches),
    groupBy,
    servers.length > 1,
    (id) => labels.get(id) ?? id
  )
}

export function siblingTabs(server: ServerState, machine: string, current: string): Siblings {
  const sessions = machineSections(server, machine, 'project', '').flatMap((section) => section.sessions)
  return { sessions, index: sessions.findIndex((s) => s.id === current) }
}

export function prBadge(pull: PullView | null | undefined): PrBadge | null {
  if (!pull) return null
  const state = pull.state.toLowerCase()
  const key: PrState = state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : pull.draft ? 'draft' : 'open'
  return { state: key, label: `#${pull.number}` }
}
