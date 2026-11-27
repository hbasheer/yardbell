import type { MachineGroupBy } from '@/state/views'

export type MachineOptions = { groupBy: MachineGroupBy; showStopped: boolean }

export const DEFAULT_OPTIONS: MachineOptions = { groupBy: 'project', showStopped: true }

const GROUPS: readonly MachineGroupBy[] = ['project', 'status', 'agent']

export function parseOptions(raw: string | null): MachineOptions {
  if (!raw) return DEFAULT_OPTIONS
  try {
    const value = JSON.parse(raw) as Partial<MachineOptions> | null
    return {
      groupBy: GROUPS.includes(value?.groupBy as MachineGroupBy) ? (value?.groupBy as MachineGroupBy) : DEFAULT_OPTIONS.groupBy,
      showStopped: typeof value?.showStopped === 'boolean' ? value.showStopped : DEFAULT_OPTIONS.showStopped
    }
  } catch {
    return DEFAULT_OPTIONS
  }
}

export function activeOptionCount(options: MachineOptions): number {
  return (
    Number(options.groupBy !== DEFAULT_OPTIONS.groupBy) + Number(options.showStopped !== DEFAULT_OPTIONS.showStopped)
  )
}

export function parseCollapsed(raw: string | null): ReadonlySet<string> {
  if (!raw) return new Set()
  try {
    const value = JSON.parse(raw) as unknown
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

export function toggleCollapsed(collapsed: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(collapsed)
  if (!next.delete(key)) next.add(key)
  return next
}

export function collapseKey(serverId: string, machine: string, groupBy: MachineGroupBy, sectionKey: string): string {
  return [serverId, machine, groupBy, sectionKey].join('|')
}

export const GROUP_LABELS: Record<MachineGroupBy, string> = { project: 'Project', status: 'Status', agent: 'Agent' }
export const GROUP_ORDER = GROUPS
