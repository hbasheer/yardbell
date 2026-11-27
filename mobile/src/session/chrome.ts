import type { Connection } from '../state/liveSocket'
import { siblingTabs, statusOf, type ServerSession, type ServerState } from '../state/views'
import type { TerminalStatus } from '../terminal/useTerminalSocket'

export type TabGroup = 'needs-you' | 'working' | 'other'
export type TabSection = { group: TabGroup; title: string; sessions: ServerSession[] }

export type SessionBody =
  | { kind: 'terminal' }
  | { kind: 'offline'; title: string; message: string }
  | { kind: 'gone'; title: string; message: string }

export type DetailRow = { key: string; label: string; value: string; url?: string }

export const TEXT_SIZES = [10, 11, 12, 13, 14, 16, 18, 20] as const
export const DEFAULT_TEXT_SIZE = 13

const GROUP_TITLE: Record<TabGroup, string> = { 'needs-you': 'Needs you', working: 'Working', other: 'Everything else' }

const real = (value: string | null | undefined): string | null => (value && value !== '-' ? value : null)

export function groupOf(session: ServerSession): TabGroup {
  const status = statusOf(session)
  return status === 'needs-you' ? 'needs-you' : status === 'working' ? 'working' : 'other'
}

export function tabSessions(entry: ServerState, machine: string, current: string): { sessions: ServerSession[]; index: number } {
  const { sessions } = siblingTabs(entry, machine, '')
  const open = sessions.filter(
    (s) => s.tmux === current || (s.attachable && Boolean(s.tmux) && statusOf(s) !== 'stopped')
  )
  return { sessions: open, index: open.findIndex((s) => s.tmux === current) }
}

export function stepTarget(
  tabs: { sessions: ServerSession[]; index: number },
  direction: 'previous' | 'next'
): ServerSession | null {
  if (tabs.index < 0) return null
  return tabs.sessions[tabs.index + (direction === 'next' ? 1 : -1)] ?? null
}

export function tabSections(sessions: ServerSession[]): TabSection[] {
  const groups: TabGroup[] = ['needs-you', 'working', 'other']
  return groups
    .map((group) => ({ group, title: GROUP_TITLE[group], sessions: sessions.filter((s) => groupOf(s) === group) }))
    .filter((section) => section.sessions.length > 0)
}

export function othersNeedYou(sessions: ServerSession[], current: string): boolean {
  return sessions.some((s) => s.tmux !== current && statusOf(s) === 'needs-you')
}

export function statusLine(session: Pick<ServerSession, 'agent' | 'branch'> | undefined): string {
  if (!session) return ''
  return [real(session.agent), real(session.branch)].filter(Boolean).join(' · ')
}

export function sessionBody(
  entry: ServerState,
  machine: string,
  name: string,
  terminal: TerminalStatus
): SessionBody {
  const { state, server } = entry
  if (!state) {
    if (entry.connection === 'unreachable') {
      return { kind: 'offline', title: `Cannot reach ${server.machine}`, message: `Cannot reach ${server.address}` }
    }
    return { kind: 'terminal' }
  }
  const host = state.machines.find((m) => m.name === machine)
  if (host && !host.up) {
    return { kind: 'offline', title: `Waiting for ${machine}`, message: host.reason || 'The machine is down.' }
  }
  const session = state.sessions.find((s) => s.machine === machine && s.tmux === name)
  if (!session) {
    if (terminal === 'open') return { kind: 'terminal' }
    return { kind: 'gone', title: 'Session ended', message: `${name} is no longer on ${machine}.` }
  }
  if (session.stopped) {
    return { kind: 'gone', title: 'Session stopped', message: `${session.stopped}. Start a new one from the machine screen.` }
  }
  if (session.stale) return { kind: 'gone', title: 'Session ended', message: `${name} is no longer running on ${machine}.` }
  return { kind: 'terminal' }
}

export function dotState(
  connection: Connection,
  terminal: TerminalStatus,
  body: SessionBody
): 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'unreachable' {
  if (connection === 'unreachable') return 'unreachable'
  if (body.kind !== 'terminal') return 'disconnected'
  if (terminal === 'open') return 'connected'
  if (terminal === 'reconnecting') return 'reconnecting'
  if (terminal === 'ended') return 'disconnected'
  return 'connecting'
}

export function detailRows(session: ServerSession, serverAddress: string): DetailRow[] {
  const path = real(session.path) ?? real(session.cwd)
  const branch = real(session.branch)
  const ticket = real(session.ticket)
  const rows: (DetailRow | null)[] = [
    { key: 'folder', label: 'Folder', value: session.folder || session.tmux || session.id },
    path ? { key: 'path', label: 'Path', value: path } : null,
    { key: 'machine', label: 'Machine', value: session.machine },
    { key: 'server', label: 'Server', value: serverAddress },
    branch ? { key: 'branch', label: 'Branch', value: branch } : null,
    session.pull
      ? {
          key: 'pull',
          label: 'Pull request',
          value: session.pull.title ? `#${session.pull.number} ${session.pull.title}` : `#${session.pull.number}`,
          url: session.pull.url
        }
      : null,
    ticket ? { key: 'ticket', label: 'Ticket', value: ticket } : null,
    real(session.agent) ? { key: 'agent', label: 'Agent', value: session.agent } : null
  ]
  return rows.filter((row): row is DetailRow => row !== null)
}

export function parseTextSize(raw: string | null): number {
  const size = Number(raw)
  return (TEXT_SIZES as readonly number[]).includes(size) ? size : DEFAULT_TEXT_SIZE
}

export const CLEAR_TERMINAL = '\x0c'
