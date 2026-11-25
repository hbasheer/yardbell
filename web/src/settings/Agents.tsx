/* eslint-disable @typescript-eslint/no-explicit-any */
// The agents list follows Orca's agent catalog in Settings (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import { useEffect, useMemo, useState } from 'react'
import { Check, Download, ExternalLink, Loader2, RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { confirmAction } from '@/lib/confirm'
import { api } from '@/pipelines/model'
import type { SettingsData } from './Integrations'
import { Section } from './ui'

type Entry = { name: string; label: string; command: string; install?: string | null; homepage?: string | null; open_source: boolean; custom: boolean }
type Filter = 'all' | 'installed' | 'missing' | 'open'

const TILE = ['bg-sky-500/15 text-sky-700 dark:text-sky-300', 'bg-violet-500/15 text-violet-700 dark:text-violet-300', 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', 'bg-amber-500/15 text-amber-700 dark:text-amber-300', 'bg-rose-500/15 text-rose-700 dark:text-rose-300']
const tileOf = (name: string) => TILE[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % TILE.length]

export function openSessionInApp(machine: string, name: string) {
  window.dispatchEvent(new CustomEvent('yardbell-open-session', { detail: { machine, name } }))
}

export function AgentsSection({ data }: { data: SettingsData }) {
  const machines = (data.machines as any[]).map((m) => m.name as string)
  const local = (data.machines as any[]).find((m) => m.local)?.name || machines[0] || ''
  const [machine, setMachine] = useState(local)
  const [list, setList] = useState<Entry[] | null>(null)
  const [installed, setInstalled] = useState<Record<string, string[] | null>>({})
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [busy, setBusy] = useState('')

  const check = (m: string, fresh = false) => {
    setInstalled((x) => ({ ...x, [m]: null }))
    api<{ installed: string[] }>('GET', `/machines/${encodeURIComponent(m)}/agents${fresh ? '?fresh=1' : ''}`).then(
      (r) => setInstalled((x) => ({ ...x, [m]: r.installed })),
      () => setInstalled((x) => ({ ...x, [m]: [] }))
    )
  }
  useEffect(() => {
    api<{ agents: Entry[] }>('GET', '/api/agents/catalog').then((r) => setList(r.agents), (e) => toast.error(e.message))
    machines.forEach((m) => check(m))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const here = installed[machine]
  const has = (a: Entry) => Boolean(here?.includes(a.name))
  const elsewhere = (a: Entry) => machines.filter((m) => m !== machine && installed[m]?.includes(a.name))
  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () =>
      (list || [])
        .filter((a) => !q || `${a.label} ${a.name} ${a.command}`.toLowerCase().includes(q))
        .filter((a) => (filter === 'installed' ? has(a) : filter === 'missing' ? !has(a) : filter === 'open' ? a.open_source : true))
        .sort((x, y) => Number(has(y)) - Number(has(x))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, q, filter, here]
  )
  const count = here ? (list || []).filter(has).length : null

  const install = async (a: Entry) => {
    const ok = await confirmAction({
      title: `Install ${a.label} on ${machine}?`,
      body: `Runs "${a.install}" on ${machine} in a new terminal, so you can watch it and answer what it asks. It may need Node, Python or your password.`,
      confirm: 'Install'
    })
    if (!ok) return
    setBusy(a.name)
    try {
      const res = await api<{ name: string }>('POST', `/api/agents/${encodeURIComponent(a.name)}/install`, { machine })
      toast(`Installing ${a.label} on ${machine}. Check again when the terminal says it is done.`)
      openSessionInApp(machine, res.name)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const chip = (on: boolean) => cn('inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors', on ? 'border-foreground/25 bg-accent text-foreground' : 'border-border text-muted-foreground hover:text-foreground')

  return (
    <Section
      title="Agents"
      description="Every coding agent Yardbell can start in a session, open-source ones included. An agent installed on a machine shows up in New session there."
      action={
        <Button size="sm" variant="outline" disabled={here === null} onClick={() => check(machine, true)}>
          <RefreshCw className={cn(here === null && 'animate-spin')} /> Check again
        </Button>
      }
    >
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Machine</span>
          {machines.map((m) => (
            <button key={m} type="button" aria-pressed={machine === m} onClick={() => setMachine(m)} className={chip(machine === m)}>
              {m}
              {installed[m] && <span className="tabular-nums text-muted-foreground">{installed[m]!.length}</span>}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[14rem] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search agents…" aria-label="Search agents" className="h-8 w-full rounded-md border border-input bg-background pr-2 pl-8 text-[13px] outline-none" />
          </div>
          {(
            [
              ['all', 'All'],
              ['installed', 'Installed'],
              ['missing', 'Not installed'],
              ['open', 'Open source']
            ] as [Filter, string][]
          ).map(([k, l]) => (
            <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={chip(filter === k)}>
              {l}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {count === null ? `Checking ${machine}…` : `${count} of ${list?.length ?? 0} installed on ${machine}.`}
        </p>
      </div>

      <div className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border/60 bg-card/30">
        {!list && <p className="px-4 py-6 text-center text-xs text-muted-foreground">Reading the agents…</p>}
        {list && !shown.length && <p className="px-4 py-6 text-center text-xs text-muted-foreground">No agents match.</p>}
        {shown.map((a) => {
          const on = has(a)
          const also = elsewhere(a)
          return (
            <div key={a.name} className="flex items-center gap-3 px-3 py-2.5">
              <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg text-[13px] font-semibold', tileOf(a.name))}>{a.label.charAt(0).toUpperCase()}</span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
                  {a.label}
                  {a.open_source && <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 text-[10px] leading-4 font-medium text-emerald-700 dark:text-emerald-300">Open source</span>}
                  {a.custom && <span className="rounded-full border border-border px-1.5 text-[10px] leading-4 text-muted-foreground">Yours</span>}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  <span className="font-mono">{a.command}</span>
                  {also.length > 0 && <span> · also on {also.join(', ')}</span>}
                </p>
              </div>
              {a.homepage && (on || a.install) && (
                <a href={a.homepage} target="_blank" rel="noopener noreferrer" title="Docs" aria-label={`${a.label} docs`} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                  <ExternalLink className="size-3.5" />
                </a>
              )}
              {here === null ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : on ? (
                <span className="inline-flex w-28 items-center justify-end gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                  <Check className="size-3.5" /> Installed
                </span>
              ) : a.install ? (
                <span className="flex w-28 justify-end">
                  <Button size="xs" variant="outline" disabled={busy === a.name} title={a.install} onClick={() => install(a)}>
                    <Download /> Install
                  </Button>
                </span>
              ) : a.homepage ? (
                <span className="flex w-28 justify-end">
                  <Button size="xs" variant="ghost" asChild>
                    <a href={a.homepage} target="_blank" rel="noopener noreferrer">
                      Install guide <ExternalLink />
                    </a>
                  </Button>
                </span>
              ) : (
                <span className="w-28 text-right text-xs text-muted-foreground">Not installed</span>
              )}
            </div>
          )
        })}
      </div>
    </Section>
  )
}
