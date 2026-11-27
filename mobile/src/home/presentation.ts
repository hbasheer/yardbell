import type { MachineRow, ServerSession } from '@/state/views'

export function machineSubtitle(row: MachineRow): string {
  if (row.status !== 'up') {
    const reason = row.reason ?? 'Not connected'
    return row.serverLabel && row.serverLabel !== row.machine ? `${reason} · ${row.serverLabel}` : reason
  }
  const where = row.serverLabel && row.serverLabel !== row.machine ? ` on ${row.serverLabel}` : ''
  const count = `${row.sessions} ${row.sessions === 1 ? 'session' : 'sessions'}`
  const needs = row.needsYou > 0 ? `, ${row.needsYou} ${row.needsYou === 1 ? 'needs' : 'need'} you` : ''
  const outside = row.outsideTmux > 0 ? ` · ${row.outsideTmux} outside tmux` : ''
  return `Connected${where} · ${count}${needs}${outside}`
}

export function previewParts(session: Pick<ServerSession, 'ticket' | 'branch'>): string {
  return [session.ticket, session.branch].filter((part) => part && part !== '-').join(' · ')
}

export function sessionHref(session: Pick<ServerSession, 'serverId' | 'machine' | 'tmux'>): string | null {
  if (!session.tmux) return null
  return `/session/${encodeURIComponent(session.serverId)}/${encodeURIComponent(session.machine)}/${encodeURIComponent(session.tmux)}`
}

export function machineHref(target: { serverId: string; machine: string }): string {
  return `/machine/${encodeURIComponent(target.serverId)}/${encodeURIComponent(target.machine)}`
}
