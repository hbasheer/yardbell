// Layout and segments adapted from Orca's status bar (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Coffee, ExternalLink, MemoryStick, Plug, RefreshCw, Server, ServerOff, Terminal } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/class-names'
import { getJson, type Machine, type Session, type YardbellState } from '@/lib/state'
import { machineTone, memPct } from '@/lib/tree'

type Window = { label: string; short?: string; used?: number; resets_at?: number; status?: string }
type Provider = { id: string; name: string; windows: Window[] }
type Usage = { providers?: Provider[]; windows?: Window[]; codex?: { windows?: Window[] } | null }
type Awake = { mode: string; holding: boolean; working?: boolean; error?: string | null }
type Port = { service?: string; remote?: number; local?: number; status?: string }
type Health = NonNullable<Machine['health']> & { load1?: number; cpus?: number; disk_total_kb?: number; disk_used_kb?: number }
export type Item = 'usage' | 'awake' | 'resources' | 'ports' | 'machines'

const REFRESH = 300000
const ITEMS_KEY = 'yardbell.statusBarItems'
export const ALL_ITEMS: { id: Item; label: string; icon: typeof Server }[] = [
  { id: 'usage', label: 'Usage', icon: RefreshCw },
  { id: 'awake', label: 'Keep Computer Awake', icon: Coffee },
  { id: 'resources', label: 'Resource Usage', icon: MemoryStick },
  { id: 'ports', label: 'Ports', icon: Plug },
  { id: 'machines', label: 'Machines', icon: Server }
]

const AWAKE = [
  { mode: 'on', word: 'On', label: 'On', desc: 'Keep this computer awake continuously' },
  { mode: 'agent', word: 'Agent', label: 'While agents work', desc: 'Stay awake while an agent is working on this computer' },
  { mode: 'off', word: 'Off', label: 'Off', desc: 'Let the computer sleep as usual' }
]

const segment = 'inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground'

const past = (w: Window) => Boolean(w.resets_at && w.resets_at * 1000 <= Date.now())
const pctOf = (w: Window) => (past(w) ? 0 : Math.round((w.used || 0) * 100))

function resetWord(epoch?: number) {
  if (!epoch) return ''
  const mins = Math.max(0, Math.round((epoch * 1000 - Date.now()) / 60000))
  if (mins < 60) return `${mins}m`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`
  return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`
}

// Older servers send only the Claude windows and Dispatch's Codex figures, without `providers`.
function providersOf(u: Usage | null): Provider[] {
  if (!u) return []
  if (Array.isArray(u.providers)) return u.providers.map((p) => ({ ...p, windows: p.windows || [] }))
  const out: Provider[] = []
  if (u.windows?.length) out.push({ id: 'claude', name: 'Claude', windows: u.windows })
  if (u.codex?.windows?.length) out.push({ id: 'codex', name: 'Codex', windows: u.codex.windows })
  return out
}

function tightest(windows: Window[]) {
  const live = windows.filter((w) => !past(w))
  const pool = live.length ? live : windows
  return pool.reduce((a, w) => ((w.used || 0) > (a.used || 0) ? w : a))
}

function ProviderMark({ id }: { id: string }) {
  if (id === 'claude')
    return (
      <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 fill-none stroke-[#d97757] stroke-[1.6] [stroke-linecap:round]" aria-hidden>
        {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((a, n) => (
          <path key={a} d={`M8 8V${n % 2 ? 2.2 : 1}`} transform={`rotate(${a} 8 8)`} />
        ))}
      </svg>
    )
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 fill-none stroke-current stroke-[1.3] [stroke-linecap:round]" aria-hidden>
      {[0, 60, 120, 180, 240, 300].map((a) => (
        <path key={a} d="M8 2.2a2.6 2.6 0 0 1 2.6 2.6v4.4" transform={`rotate(${a} 8 8)`} />
      ))}
    </svg>
  )
}

const ITEMS_EVENT = 'yardbell-statusbar'

export function setStatusItems(list: Item[]) {
  try {
    localStorage.setItem(ITEMS_KEY, JSON.stringify(list))
  } catch {}
  window.dispatchEvent(new Event(ITEMS_EVENT))
}

export function readItems(): Item[] {
  try {
    const saved = JSON.parse(localStorage.getItem(ITEMS_KEY) || 'null')
    if (Array.isArray(saved)) return saved
  } catch {}
  return ALL_ITEMS.map((i) => i.id)
}

function PopHead({ icon: Icon, title, note }: { icon: typeof Server; title: string; note?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-foreground">
        <Icon className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate">{title}</span>
      </div>
      {note && <span className="text-[11px] tabular-nums text-muted-foreground">{note}</span>}
    </div>
  )
}

function UsageArea() {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const load = () =>
      getJson<Usage>('/dispatch/usage')
        .then(setUsage)
        .catch(() => {})
    load()
    const timer = setInterval(() => !document.hidden && load(), REFRESH)
    return () => clearInterval(timer)
  }, [])

  const refresh = async () => {
    setBusy(true)
    try {
      const res = await fetch('/dispatch/usage/refresh', { method: 'POST', headers: { Accept: 'application/json' } })
      if (res.ok) setUsage(await res.json())
    } finally {
      setBusy(false)
    }
  }

  const list = providersOf(usage).filter((p) => p.windows.length)
  return (
    <div className={cn('relative flex flex-1 items-center gap-1 overflow-clip [overflow-clip-margin:3px]', list.length ? 'min-w-16' : 'min-w-0')}>
      {list.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" aria-label="Usage" className="inline-flex shrink-0 items-center gap-3 rounded px-1 py-0.5 hover:bg-accent/70 data-[state=open]:bg-accent/70">
              {list.map((p) => {
                const w = tightest(p.windows)
                return (
                  <span key={p.id} className="inline-flex items-center gap-1.5">
                    <ProviderMark id={p.id} />
                    <span className="block h-[6px] w-[48px] shrink-0 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-muted-foreground/40" style={{ width: `${pctOf(w)}%` }} />
                    </span>
                    {p.windows.map((x, i) => (
                      <span key={x.label} className="inline-flex items-center gap-1.5">
                        {i > 0 && <span className="text-muted-foreground">·</span>}
                        <span className="tabular-nums">
                          <span className="text-muted-foreground">{x.short || x.label}</span> {past(x) ? 'reset' : `${pctOf(x)}%`}
                          {!past(x) && x.resets_at && pctOf(x) >= 80 ? <span className="text-muted-foreground"> {resetWord(x.resets_at)}</span> : null}
                        </span>
                      </span>
                    ))}
                    {w.status && w.status !== 'allowed' && !past(w) && <AlertTriangle size={11} className="text-muted-foreground/80" />}
                  </span>
                )
              })}
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" sideOffset={8} className="w-[440px] max-w-[calc(100vw-1rem)] p-0">
            <PopHead icon={RefreshCw} title="Usage" note="Rate limits per provider" />
            <div className="grid gap-3 p-3">
              {list.map((p) => (
                <section key={p.id} className="grid gap-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <ProviderMark id={p.id} /> {p.name}
                  </div>
                  {p.windows.map((x) => {
                    const pct = pctOf(x)
                    return (
                      <div key={x.label} className="grid grid-cols-[7rem_1fr_2.5rem_4.5rem] items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
                        <span className="truncate">{x.label}</span>
                        <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <span
                            className={cn('block h-full rounded-full', pct >= 90 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-600 dark:bg-yellow-500' : 'bg-emerald-600 dark:bg-emerald-500')}
                            style={{ width: `${pct}%` }}
                          />
                        </span>
                        <span className={cn('text-right', pct >= 90 && 'text-destructive')}>{past(x) ? '0%' : `${pct}%`}</span>
                        <span className="truncate text-right">{past(x) ? 'reset' : x.resets_at ? `in ${resetWord(x.resets_at)}` : ''}</span>
                      </div>
                    )
                  })}
                </section>
              ))}
            </div>
            <div className="flex items-center justify-end border-t border-border px-3 py-1.5">
              <button type="button" onClick={refresh} disabled={busy} className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">
                <RefreshCw className={cn('size-3', busy && 'animate-spin')} /> Check now
              </button>
            </div>
          </PopoverContent>
        </Popover>
      )}
      <button
        type="button"
        onClick={refresh}
        disabled={busy}
        aria-label="Check usage now"
        title="Check usage now"
        className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
      >
        <RefreshCw size={11} className={cn(busy && 'animate-spin')} />
      </button>
    </div>
  )
}

function AwakeSegment({ awake }: { awake: Awake }) {
  const [saved, setSaved] = useState<Awake | null>(null)
  const [error, setError] = useState('')
  const now = saved && saved.mode !== awake.mode ? saved : awake
  const word = AWAKE.find((a) => a.mode === now.mode)?.word || 'Off'
  const status = now.error ? 'Unavailable' : now.holding ? 'Active' : 'Inactive'
  const label = `Keep computer awake: ${word}, ${status.toLowerCase()}`

  const set = async (mode: string) => {
    setError('')
    try {
      const res = await fetch('/api/settings/keep-awake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ mode })
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `Yardbell answered ${res.status}`)
      setSaved(body)
    } catch (e) {
      setError(`Couldn't save: ${(e as Error).message}`)
    }
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={label} title={label} className={cn(segment, 'gap-1')}>
          <Coffee className={cn('size-3', now.holding && 'text-foreground')} />
          <span className="text-[11px] font-medium">{word}</span>
          <span aria-hidden className={cn('size-1.5 rounded-full', now.holding ? 'bg-foreground' : 'bg-muted-foreground/40')} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" sideOffset={8} className="w-64">
        <DropdownMenuLabel className="flex items-center justify-between gap-3 text-xs tracking-normal normal-case">
          <span className="text-foreground">Keep computer awake</span>
          <span className="font-normal">{status}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {AWAKE.map((a) => (
          <DropdownMenuItem key={a.mode} className="items-start py-1.5" onSelect={() => set(a.mode)}>
            <Check className={cn('mt-0.5 size-3.5', now.mode !== a.mode && 'invisible')} />
            <span className="flex flex-col">
              <span>{a.label}</span>
              <span className="text-[11px] text-muted-foreground">{a.desc}</span>
            </span>
          </DropdownMenuItem>
        ))}
        {(error || now.error) && <p className="px-2.5 py-1.5 text-[11px] text-destructive">{error || now.error}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const gb = (kb?: number) => (kb ? `${(kb / 1048576).toFixed(kb > 10485760 ? 0 : 1)} GB` : '')

function ResourceSegment({ machines, sessions }: { machines: Machine[]; sessions: Session[] }) {
  const here = machines.find((m) => m.local) || machines.find((m) => m.up)
  const mem = here?.up ? memPct(here) : null
  const tone = here ? machineTone(here) : 'ok'
  const live = sessions.filter((s) => s.tmux && s.attachable && !s.stale)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Resource usage" className={segment}>
          <MemoryStick className={cn('size-3', tone === 'bad' ? 'text-destructive' : tone === 'warn' ? 'text-status-warning-text' : 'text-muted-foreground')} />
          {mem != null && <span className="text-[11px] tabular-nums">{mem}%</span>}
          <Terminal className="size-3 text-muted-foreground" />
          <span className="text-[11px] tabular-nums">{live.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-[22rem] max-w-[calc(100vw-2rem)] p-0">
        <PopHead icon={MemoryStick} title="Resource usage" note={`${live.length} session${live.length === 1 ? '' : 's'}`} />
        <div className="scrollbar-sleek max-h-[28rem] overflow-y-auto p-1">
          {machines.map((m) => {
            const h = (m.health || {}) as Health
            const pct = m.up ? memPct(m) : null
            const count = live.filter((s) => s.machine === m.name).length
            const disk = h.disk_total_kb ? Math.round(((h.disk_used_kb || 0) / h.disk_total_kb) * 100) : null
            return (
              <div key={m.name} className="grid gap-1 rounded-md px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <Server className="size-3 text-muted-foreground" />
                  <span className="font-medium text-foreground">{m.name}</span>
                  {m.local && <span className="text-[10px] text-muted-foreground/70">This computer</span>}
                  <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{m.up ? `${count} session${count === 1 ? '' : 's'}` : 'offline'}</span>
                </div>
                {m.up && (
                  <div className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-x-2 gap-y-1 pl-5 text-[11px] text-muted-foreground tabular-nums">
                    {pct != null && (
                      <>
                        <span>Memory</span>
                        <span className="h-1 overflow-hidden rounded-full bg-muted">
                          <span className={cn('block h-full rounded-full', pct >= 90 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-600 dark:bg-yellow-500' : 'bg-muted-foreground/40')} style={{ width: `${pct}%` }} />
                        </span>
                        <span>
                          {pct}% of {gb(h.mem_total_kb)}
                        </span>
                      </>
                    )}
                    {disk != null && (
                      <>
                        <span>Disk</span>
                        <span className="h-1 overflow-hidden rounded-full bg-muted">
                          <span className="block h-full rounded-full bg-muted-foreground/40" style={{ width: `${disk}%` }} />
                        </span>
                        <span>
                          {disk}% of {gb(h.disk_total_kb)}
                        </span>
                      </>
                    )}
                    {h.load1 != null && (
                      <>
                        <span>Load</span>
                        <span />
                        <span>
                          {h.load1.toFixed(2)}
                          {h.cpus ? ` on ${h.cpus} CPUs` : ''}
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function PortsSegment({ sessions }: { sessions: Session[] }) {
  const rows = sessions.flatMap((s) => ((s as Session & { ports?: Port[] }).ports || []).map((p) => ({ p, s })))
  const machines = new Set(rows.map((r) => r.s.machine))
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`${rows.length} forwarded ports`} className={segment}>
          <Plug className="size-3 text-muted-foreground" />
          <span className="text-[11px] font-medium tabular-nums">{rows.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-[24rem] max-w-[calc(100vw-2rem)] p-0">
        <PopHead icon={Plug} title={`Live ports (${rows.length})`} note={rows.length ? `${machines.size} machine${machines.size === 1 ? '' : 's'}` : undefined} />
        {!rows.length ? (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">No ports are forwarded right now.</p>
        ) : (
          <div className="scrollbar-sleek max-h-[28rem] overflow-y-auto p-1">
            {rows.map(({ p, s }) => {
              const url = p.local ? `${location.protocol}//${location.hostname}:${p.local}` : ''
              return (
                <div key={`${s.id}:${p.remote}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent">
                  <span className={cn('size-1.5 shrink-0 rounded-full', p.status === 'up' || !p.status ? 'bg-status-success' : 'bg-muted-foreground/40')} />
                  <span className="min-w-0 flex-1 truncate">{p.service || s.branch || 'app'}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {s.machine}:{p.remote} → {p.local}
                  </span>
                  {url && (
                    <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${p.service || 'the app'}`} className="text-muted-foreground hover:text-foreground">
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function MachinesSegment({ machines }: { machines: Machine[] }) {
  const up = machines.filter((m) => m.up).length
  const trouble = machines.some((m) => machineTone(m) !== 'ok')
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`${up} of ${machines.length} machines online`} className={segment}>
          {up < machines.length ? <ServerOff className="size-3 text-status-warning-text" /> : <Server className="size-3" />}
          <span className={cn('text-[11px] font-medium tabular-nums', trouble && 'text-status-warning-text')}>
            {up}/{machines.length}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-72 p-0">
        <PopHead icon={Server} title="Machines" note={`${up} of ${machines.length} online`} />
        <div className="p-1">
          {machines.map((m) => {
            const tone = machineTone(m)
            return (
              <div key={m.name} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs">
                <span className={cn('size-1.5 shrink-0 rounded-full', !m.up ? 'bg-destructive' : tone === 'warn' ? 'bg-status-warning' : 'bg-status-success')} />
                <span className="font-medium text-foreground">{m.name}</span>
                {m.local && <span className="text-[10px] text-muted-foreground/70">This computer</span>}
                <span className={cn('ml-auto truncate text-[11px]', m.up ? 'text-muted-foreground' : 'text-destructive')}>
                  {m.up ? (memPct(m) != null ? `memory at ${memPct(m)}%` : 'online') : m.reason || 'offline'}
                </span>
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function StatusBar({ state }: { state: YardbellState | null }) {
  const [items, setItems] = useState<Item[]>(readItems)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const machines = state?.machines ?? []
  const sessions = state?.sessions ?? []
  const awake = (state as { keep_awake?: Awake } | null)?.keep_awake
  const shows = (id: Item) => items.includes(id)

  useEffect(() => {
    const heard = () => setItems(readItems())
    window.addEventListener(ITEMS_EVENT, heard)
    return () => window.removeEventListener(ITEMS_EVENT, heard)
  }, [])

  const toggle = (id: Item) => setStatusItems(shows(id) ? items.filter((i) => i !== id) : [...items, id])

  return (
    <div
      className="relative col-span-full flex h-6 min-h-[24px] shrink-0 items-center gap-4 overflow-clip border-t border-border bg-[var(--bg-titlebar,var(--card))] px-3 text-xs whitespace-nowrap select-none [overflow-clip-margin:3px]"
      onContextMenuCapture={(e) => {
        if ((e.target as HTMLElement).closest('[data-radix-popper-content-wrapper]')) return
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        setMenu({ x: e.clientX - r.left, y: e.clientY - r.top })
      }}
    >
      {shows('usage') ? <UsageArea /> : <span className="flex-1" />}
      <div className="-mx-1 flex min-w-0 items-center self-stretch overflow-x-auto [scrollbar-width:none]">
        <div className="flex w-max items-center gap-3 px-1">
          {shows('awake') && awake && <AwakeSegment awake={awake} />}
          {shows('resources') && machines.length > 0 && <ResourceSegment machines={machines} sessions={sessions} />}
          {shows('ports') && <PortsSegment sessions={sessions} />}
          {shows('machines') && machines.length > 0 && <MachinesSegment machines={machines} />}
        </div>
      </div>
      <DropdownMenu modal={false} open={Boolean(menu)} onOpenChange={(o) => !o && setMenu(null)}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none absolute size-px opacity-0" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-fit min-w-0" sideOffset={0} align="start">
          {ALL_ITEMS.map((i) => (
            <DropdownMenuItem
              key={i.id}
              onSelect={(e) => {
                e.preventDefault()
                toggle(i.id)
              }}
            >
              <Check className={cn('size-3.5', !shows(i.id) && 'invisible')} />
              <i.icon className="size-3.5" />
              {i.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
