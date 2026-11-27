import { machineRows, type MachineRowStatus, type ServerState } from '../state/views'

export type MachineBody = 'loading' | 'unreachable' | 'down' | 'empty' | 'no-match' | 'list'

export type MachineStatus = {
  status: MachineRowStatus | 'loading'
  reason: string | null
  sessions: number
  needsYou: number
}

export function machineStatus(entry: ServerState, machine: string): MachineStatus {
  if (!entry.state) {
    if (entry.connection === 'unreachable') {
      return { status: 'unreachable', reason: `Cannot reach ${entry.server.address}`, sessions: 0, needsYou: 0 }
    }
    return { status: 'loading', reason: null, sessions: 0, needsYou: 0 }
  }
  const row = machineRows([entry]).find((r) => r.machine === machine)
  if (!row) {
    return { status: 'down', reason: `${entry.server.machine} does not list ${machine}`, sessions: 0, needsYou: 0 }
  }
  return { status: row.status, reason: row.reason, sessions: row.sessions, needsYou: row.needsYou }
}

export function machineBody(
  entry: ServerState,
  machine: string,
  query: string,
  visibleSessions: number
): MachineBody {
  const { status } = machineStatus(entry, machine)
  if (status === 'loading') return 'loading'
  if (status === 'unreachable' && !entry.state) return 'unreachable'
  if (status === 'down') return 'down'
  if (visibleSessions > 0) return 'list'
  if (entry.connection !== 'connected') return 'unreachable'
  const total = entry.state?.sessions.filter((s) => s.machine === machine).length ?? 0
  if (query.trim() !== '' && total > 0) return 'no-match'
  return 'empty'
}

export function stateLine(status: MachineStatus, serverLabel: string | null): string {
  if (status.status === 'loading') return 'Connecting'
  if (status.status !== 'up') return status.reason ?? 'Not connected'
  const where = serverLabel ? ` on ${serverLabel}` : ''
  const count = `${status.sessions} ${status.sessions === 1 ? 'session' : 'sessions'}`
  const needs = status.needsYou > 0 ? `, ${status.needsYou} ${status.needsYou === 1 ? 'needs' : 'need'} you` : ''
  return `Connected${where} · ${count}${needs}`
}
