import type { HealthView } from './types'

export const RATED = 85
export const CRITICAL = 95

export type Level = 'normal' | 'warn' | 'bad'

export const gb = (kb: number) => (kb / 1048576).toFixed(1)

export const levelOf = (pct: number): Level => (pct >= CRITICAL ? 'bad' : pct >= RATED ? 'warn' : 'normal')

const percent = (used: number | undefined, total: number | undefined) =>
  total ? Math.round(((used ?? 0) / total) * 100) : null

export const memoryPercent = (h: HealthView | null | undefined) => (h ? percent(h.mem_used_kb, h.mem_total_kb) : null)
export const limitPercent = (h: HealthView | null | undefined) => (h ? percent(h.limit_used_kb, h.limit_kb) : null)
export const diskPercent = (h: HealthView | null | undefined) => (h ? percent(h.disk_used_kb, h.disk_total_kb) : null)

export function pressure(h: HealthView | null | undefined): number {
  return Math.max(memoryPercent(h) ?? 0, limitPercent(h) ?? 0)
}

export type MemoryPart = { key: 'agents' | 'mine' | 'other' | 'free'; label: string; kb: number; share: number }

export type Resources = {
  memory: { pct: number; level: Level; totalGb: string; parts: MemoryPart[] } | null
  cpu: { load: string; cpus: number | null } | null
  disk: { pct: number; level: Level; totalGb: string; freeGb: string } | null
  limit: { pct: number; level: Level; usedGb: string; limitGb: string } | null
}

function memoryParts(h: HealthView): MemoryPart[] {
  // RSS counts shared pages once per process, so the per-account sums can exceed what is in use.
  const used = Math.min(h.mem_used_kb, h.mem_total_kb)
  const agents = Math.min(h.agent_kb, used)
  const split = h.user_kb > 0
  const mine = split ? Math.min(Math.max(h.user_kb, agents), used) : agents
  const others = used - mine
  const share = (kb: number) => (kb / h.mem_total_kb) * 100
  const parts: MemoryPart[] = [{ key: 'agents', label: 'Agents', kb: agents, share: share(agents) }]
  if (split) parts.push({ key: 'mine', label: 'Your other processes', kb: mine - agents, share: share(mine - agents) })
  if (!split || others > 0) {
    parts.push({ key: 'other', label: split ? 'Other accounts' : 'Other', kb: others, share: share(others) })
  }
  const free = Math.max(h.mem_total_kb - used, 0)
  parts.push({ key: 'free', label: 'Free', kb: free, share: share(free) })
  return parts
}

export function resourcesOf(up: boolean, h: HealthView | null | undefined): Resources | null {
  if (!up || !h) return null
  const mem = memoryPercent(h)
  const disk = diskPercent(h)
  const limit = limitPercent(h)
  const resources: Resources = {
    memory: mem === null ? null : { pct: mem, level: levelOf(mem), totalGb: gb(h.mem_total_kb), parts: memoryParts(h) },
    cpu: h.load1 == null ? null : { load: Number(h.load1).toFixed(1), cpus: h.cpus || null },
    disk:
      disk === null
        ? null
        : {
            pct: disk,
            level: levelOf(disk),
            totalGb: gb(h.disk_total_kb ?? 0),
            freeGb: gb(Math.max((h.disk_total_kb ?? 0) - (h.disk_used_kb ?? 0), 0))
          },
    limit:
      limit === null
        ? null
        : { pct: limit, level: levelOf(limit), usedGb: gb(h.limit_used_kb), limitGb: gb(h.limit_kb) }
  }
  return resources.memory || resources.cpu || resources.disk || resources.limit ? resources : null
}

export type SummaryPart = { text: string; level: Level }

export function resourceSummary(resources: Resources | null): SummaryPart[] {
  if (!resources) return []
  const parts: SummaryPart[] = []
  const { memory, limit, cpu, disk } = resources
  if (memory) parts.push({ text: `Memory ${memory.pct}%`, level: memory.level })
  if (limit && limit.pct > (memory?.pct ?? 0)) parts.push({ text: `Limit ${limit.pct}%`, level: limit.level })
  if (cpu) parts.push({ text: `CPU ${cpu.load}`, level: 'normal' })
  if (disk) parts.push({ text: `Disk ${disk.pct}%`, level: disk.level })
  return parts
}
