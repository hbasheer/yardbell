import type { Proposal } from './api'
import type { ServerState } from '../state/views'

export type InboxTab = 'all' | 'waiting' | 'decided'

export type InboxSection = { key: 'waiting' | 'decided'; title: string; proposals: Proposal[] }

export type InboxCounts = { waiting: number; decided: number }

export type InboxRow = { serverId: string; machine: string; waiting: number }

const isWaiting = (proposal: Proposal) => proposal.status === 'pending'

export function countsOf(proposals: Proposal[]): InboxCounts {
  const waiting = proposals.filter(isWaiting).length
  return { waiting, decided: proposals.length - waiting }
}

export function sectionsFor(proposals: Proposal[], tab: InboxTab): InboxSection[] {
  const waiting = proposals.filter(isWaiting)
  const decided = proposals.filter((proposal) => !isWaiting(proposal))
  const sections: InboxSection[] = []
  if (tab !== 'decided' && waiting.length > 0) sections.push({ key: 'waiting', title: 'Waiting for you', proposals: waiting })
  if (tab !== 'waiting' && decided.length > 0) sections.push({ key: 'decided', title: 'Decided', proposals: decided })
  return sections
}

export function emptyCopy(tab: InboxTab): { title: string; message?: string } {
  if (tab === 'waiting') return { title: 'Nothing waits for you.' }
  if (tab === 'decided') return { title: 'Nothing decided yet.' }
  return { title: 'Nothing waits for you.', message: 'Changes that MCP clients ask for land here.' }
}

export function deleteCopy(proposal: Proposal): { title: string; message?: string } {
  if (proposal.status === 'pending') {
    return { title: 'Delete this proposal?', message: 'It has not run, and it will not.' }
  }
  return { title: 'Delete this proposal?' }
}

export function inboxRows(servers: ServerState[]): InboxRow[] {
  return servers.flatMap(({ server, state }) => {
    const waiting = state?.proposals ?? 0
    return waiting > 0 ? [{ serverId: server.id, machine: server.machine, waiting }] : []
  })
}

export function inboxRowSubtitle(row: InboxRow, serverCount: number): string {
  const text = row.waiting === 1 ? '1 proposal waits for you' : `${row.waiting} proposals wait for you`
  return serverCount > 1 ? `${text} · ${row.machine}` : text
}

export const inboxHref = (serverId: string) => `/inbox/${encodeURIComponent(serverId)}`
