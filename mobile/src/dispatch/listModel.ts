import type { ConversationSummary } from './types'

export type ConversationRow = ConversationSummary & { serverId: string; machine: string; pipeline?: boolean }

export function pipelinedIds(runs: readonly { conversation?: string }[]): Set<string> {
  return new Set(runs.flatMap((run) => (run.conversation ? [run.conversation] : [])))
}

export type ChatState = 'waiting' | 'working' | 'idle'

export const FEED_LIMIT = 3

export function chatState(chat: Pick<ConversationSummary, 'waiting' | 'busy'>): ChatState {
  if (chat.waiting > 0) return 'waiting'
  return chat.busy ? 'working' : 'idle'
}

export function timeAgo(stamp: string, now: number = Date.now()): string {
  const at = Date.parse(stamp)
  if (Number.isNaN(at)) return ''
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'Just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} d ago`
  return new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short' })
}

export function stateWord(chat: ConversationSummary, now: number = Date.now()): { word: string; rest: string; state: ChatState } {
  const state = chatState(chat)
  if (state === 'waiting') return { word: 'Needs you', rest: `${chat.waiting} waiting`, state }
  if (state === 'working') return { word: 'Working', rest: '', state }
  return { word: timeAgo(chat.updated, now), rest: '', state }
}

export function footerOf(chat: ConversationSummary): string {
  const backend = chat.backend === 'codex' ? 'Codex' : chat.backend === 'claude' ? 'Claude' : ''
  return [chat.trigger ? `Trigger ${chat.trigger}` : '', backend].filter(Boolean).join(' · ')
}

const newestFirst = (a: ConversationRow, b: ConversationRow) => Date.parse(b.updated) - Date.parse(a.updated)

export function sortRows(rows: ConversationRow[]): ConversationRow[] {
  return [...rows].sort(newestFirst)
}

export function filterRows(rows: ConversationRow[], query: string): ConversationRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return rows
  return rows.filter((row) => row.title.toLowerCase().includes(needle))
}

export function feedPick(rows: ConversationRow[], limit: number = FEED_LIMIT): ConversationRow[] {
  const active = rows.filter((row) => chatState(row) !== 'idle')
  const rank = (row: ConversationRow) => (chatState(row) === 'waiting' ? 0 : 1)
  return active.sort((a, b) => rank(a) - rank(b) || newestFirst(a, b)).slice(0, limit)
}

export function activeCount(rows: ConversationRow[]): number {
  return rows.filter((row) => chatState(row) !== 'idle').length
}

export function dispatchWaiting(servers: readonly { state?: { waiting?: number } }[]): number {
  return servers.reduce((sum, entry) => sum + (entry.state?.waiting ?? 0), 0)
}

export type ServerGroup = { serverId: string; machine: string; rows: ConversationRow[] }

export function groupByServer(rows: ConversationRow[]): ServerGroup[] {
  const groups = new Map<string, ServerGroup>()
  for (const row of rows) {
    const group = groups.get(row.serverId) ?? { serverId: row.serverId, machine: row.machine, rows: [] }
    group.rows.push(row)
    groups.set(row.serverId, group)
  }
  return [...groups.values()]
}

export const clearedMessage = (kept: number) =>
  kept === 0 ? 'Cleared every chat.' : kept === 1 ? 'Cleared the chats. 1 is still working and was kept.' : `Cleared the chats. ${kept} are still working and were kept.`

export const dispatchHref = (serverId: string, id: string) =>
  `/dispatch/${encodeURIComponent(serverId)}/${encodeURIComponent(id)}`
export const newChatHref = (serverId: string) => dispatchHref(serverId, 'new')
export const promptsHref = (serverId: string) => dispatchHref(serverId, 'prompts')

export const BUSY_DELETE = 'Dispatch is still working on this chat'
