export type UsageWindow = { label: string; short?: string; used?: number; resets_at?: number; status?: string }
export type UsageProvider = { id: string; name: string; windows: UsageWindow[]; status?: string; message?: string }
export type UsageReply = {
  providers?: UsageProvider[]
  windows?: UsageWindow[]
  codex?: { windows?: UsageWindow[] } | null
}

export type MeterTone = 'ok' | 'warn' | 'critical'

export function providersOf(reply: UsageReply | null | undefined): UsageProvider[] {
  if (!reply) return []
  if (Array.isArray(reply.providers)) {
    return reply.providers.map((p) => ({ ...p, windows: p.windows ?? [] })).filter((p) => p.windows.length > 0 || Boolean(p.message))
  }
  const out: UsageProvider[] = []
  if (reply.windows?.length) out.push({ id: 'claude', name: 'Claude', windows: reply.windows })
  if (reply.codex?.windows?.length) out.push({ id: 'codex', name: 'Codex', windows: reply.codex.windows })
  return out
}

export function isPast(window: UsageWindow, nowMs: number): boolean {
  return Boolean(window.resets_at && window.resets_at * 1000 <= nowMs)
}

export function percentOf(window: UsageWindow, nowMs: number): number {
  if (isPast(window, nowMs)) return 0
  return Math.min(100, Math.max(0, Math.round((window.used ?? 0) * 100)))
}

export function tightestWindow(windows: UsageWindow[], nowMs: number): UsageWindow {
  const live = windows.filter((w) => !isPast(w, nowMs))
  const pool = live.length > 0 ? live : windows
  return pool.reduce((a, w) => ((w.used ?? 0) > (a.used ?? 0) ? w : a))
}

export function toneOf(percent: number): MeterTone {
  if (percent >= 90) return 'critical'
  if (percent >= 80) return 'warn'
  return 'ok'
}

export function resetWord(epochSeconds: number | undefined, nowMs: number): string {
  if (!epochSeconds) return ''
  const mins = Math.max(0, Math.round((epochSeconds * 1000 - nowMs) / 60000))
  if (mins < 60) return `${mins}m`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`
  return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`
}

export function resetLabel(window: UsageWindow, nowMs: number): string {
  if (isPast(window, nowMs)) return 'reset'
  return window.resets_at ? `resets in ${resetWord(window.resets_at, nowMs)}` : ''
}
