import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, CircleDashed, CircleDot, CircleX, ExternalLink, GitPullRequest, History, LoaderCircle, Plug, RefreshCw, RotateCcw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { getJson, type Session, type YardbellState } from '@/lib/state'
import type { Place } from './SendNotes'
import { sessionsIn } from './SendNotes'

type Past = { id: string; folder: string; title: string; prompt: string; summary: string; updated: number; messages: number }
type Pull = {
  number?: number
  url?: string
  title?: string
  state?: string
  ci?: string
  review?: string
  mergeable?: string
  draft?: boolean
  forge?: string
  failed?: string[]
  base?: string
}
type Port = { service?: string; remote?: number; local?: number; status?: string; url?: string }

const ago = (secs: number) => {
  const m = Math.max(0, Math.round((Date.now() / 1000 - secs) / 60))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 1440) return `${Math.floor(m / 60)}h ago`
  return `${Math.floor(m / 1440)}d ago`
}

const note = 'px-3 py-2 text-xs text-muted-foreground'

// An empty panel says what would show there, as the Checks panel always has.
export function PanelEmpty({ icon: Icon, title, children }: { icon: React.ComponentType<{ className?: string }>; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 pt-10 text-center">
      <Icon className="size-5 text-muted-foreground" />
      <p className="text-[12px] font-medium text-foreground">{title}</p>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{children}</p>
    </div>
  )
}

// Past Claude Code conversations in this folder, each one a click from running again.
export function HistoryTab({ place, onResumed }: { place: Place; onResumed: (key: string) => void }) {
  const [data, setData] = useState<{ sessions: Past[]; scanned: number } | { error: string } | null>(null)
  const [find, setFind] = useState('')
  const [busy, setBusy] = useState('')
  const load = () => {
    setData(null)
    getJson<{ sessions: Past[]; scanned: number }>(`/machines/${encodeURIComponent(place.machine)}/history?${new URLSearchParams({ path: place.path })}`)
      .then(setData)
      .catch((e) => setData({ error: e.message }))
  }
  useEffect(load, [place.machine, place.path])

  const resume = async (id: string) => {
    setBusy(id)
    try {
      const res = await fetch('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ machine: place.machine, path: place.path, agent: 'claude', resume_id: id, wait: true })
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `Could not resume the session (${res.status})`)
      onResumed(`${place.machine}/${body.name}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  if (!data) return <p className={note}>Reading Claude Code’s history…</p>
  if ('error' in data)
    return (
      <p role="alert" className="px-3 py-2 text-xs text-destructive">
        {data.error}
      </p>
    )
  const words = find.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = data.sessions.filter((s) => words.every((w) => `${s.title}\n${s.prompt}\n${s.summary}`.toLowerCase().includes(w)))
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 p-2">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-input bg-background px-2">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder="Search past sessions"
            className="min-w-0 flex-1 bg-transparent text-xs outline-none"
          />
        </label>
        <button
          type="button"
          aria-label="Refresh"
          onClick={load}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-1 pb-4">
        {!data.sessions.length && (
          <PanelEmpty icon={History} title="No past sessions">
            Claude Code conversations that ran in this folder show up here, so you can read them or resume one.
          </PanelEmpty>
        )}
        {shown.map((s) => (
          <div key={s.id} className="group/past rounded-md px-2 py-1.5 hover:bg-accent">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">{s.title || s.prompt || 'Untitled'}</span>
              <span className="shrink-0 text-2xs text-muted-foreground">{ago(s.updated)}</span>
            </div>
            {s.summary && <p className="line-clamp-2 text-xs text-muted-foreground">{s.summary}</p>}
            <div className="mt-1 flex items-center gap-2 text-2xs text-muted-foreground">
              <span>{s.messages} messages</span>
              <Button size="xs" variant="outline" className="ml-auto" disabled={Boolean(busy)} onClick={() => resume(s.id)}>
                {busy === s.id ? <LoaderCircle className="size-3 animate-spin" /> : <RotateCcw className="size-3" />} Resume
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function stateBadge(p: Pull): { word: string; cls: string } {
  if (p.state === 'merged') return { word: 'Merged', cls: 'border-purple-500/40 bg-purple-500/10 text-purple-600 dark:text-purple-400' }
  if (p.state === 'closed') return { word: 'Closed', cls: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400' }
  if (p.draft) return { word: 'Draft', cls: 'border-border bg-muted text-muted-foreground' }
  return { word: 'Open', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' }
}

function CiIcon({ ci }: { ci?: string }) {
  if (ci === 'passing') return <CircleCheck className="size-3.5 shrink-0 text-emerald-500" />
  if (ci === 'failing') return <CircleX className="size-3.5 shrink-0 text-rose-500" />
  if (ci === 'pending') return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-amber-500" />
  return <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" />
}

const CI_WORD: Record<string, string> = { passing: 'All checks passed', failing: 'Some checks failed', pending: 'Checks are running' }
const REVIEW_WORD: Record<string, string> = { approved: 'Approved', changes_requested: 'Changes requested', review_required: 'Review required' }

// The pull or merge request of each branch in this folder, laid out like a review panel.
export function ChecksTab({ place, state }: { place: Place; state: YardbellState | null }) {
  const [busy, setBusy] = useState(false)
  const pulls = new Map<string, { pull: Pull; session: Session }>()
  const why = new Set<string>()
  for (const s of sessionsIn(state, place.machine, place.path)) {
    const p = s.pull as Pull | null | undefined
    if (p?.number && !pulls.has(String(p.url || p.number))) pulls.set(String(p.url || p.number), { pull: p, session: s })
    const w = (s as Session & { pull_why?: string }).pull_why
    if (!p?.number && w) why.add(w)
  }
  const refresh = async () => {
    setBusy(true)
    await fetch('/refresh', { method: 'POST' }).catch(() => {})
    setTimeout(() => setBusy(false), 800)
  }
  if (!pulls.size)
    return (
      <div className="flex flex-col items-center gap-2 px-6 pt-10 text-center">
        <GitPullRequest className="size-5 text-muted-foreground" />
        <p className="text-[12px] font-medium text-foreground">No pull request</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {[...why][0] || 'When a branch here has a pull or merge request, its checks and review show up here.'}
        </p>
      </div>
    )
  return (
    <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
      {[...pulls.values()].map(({ pull, session }) => {
        const ref = `${pull.forge === 'gitlab' ? '!' : '#'}${pull.number}`
        const badge = stateBadge(pull)
        const failed = pull.failed || []
        return (
          <section key={ref} className="border-b border-border">
            <div className="flex flex-col gap-1 px-3 pt-2.5 pb-2">
              <div className="flex items-center gap-2">
                <GitPullRequest className="size-4 shrink-0 text-muted-foreground" />
                <a
                  href={pull.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded px-0.5 text-[12px] font-semibold text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  {pull.forge === 'gitlab' ? 'MR' : 'PR'} {ref}
                </a>
                <span className={cn('rounded border px-1.5 py-px text-[10px] font-medium', badge.cls)}>{badge.word}</span>
                <span className="flex-1" />
                <button
                  type="button"
                  aria-label="Refresh"
                  title="Refresh"
                  disabled={busy}
                  onClick={refresh}
                  className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50"
                >
                  <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
                </button>
                {pull.url && (
                  <a href={pull.url} target="_blank" rel="noreferrer" aria-label="Open in the browser" title="Open in the browser" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                    <ExternalLink className="size-3.5" />
                  </a>
                )}
              </div>
              {pull.title && <p className="line-clamp-2 text-[12px] leading-snug text-foreground">{pull.title}</p>}
              <p className="truncate font-mono text-[10px] text-muted-foreground">
                {session.branch}
                {pull.base ? ` → ${pull.base}` : ''}
              </p>
            </div>
            <div className="flex w-full items-center gap-3 border-y border-border px-3 py-2 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <CiIcon ci={pull.ci} />
                {pull.ci ? CI_WORD[pull.ci] || pull.ci : 'No checks reported'}
              </span>
            </div>
            <div className="py-1">
              {failed.map((name) => (
                <div key={name} className="flex items-center gap-2 px-3 py-1.5">
                  <CircleX className="size-3.5 shrink-0 text-rose-500" />
                  <span className="flex-1 truncate text-[12px] text-foreground">{name}</span>
                  {pull.url && (
                    <a href={`${pull.url}${pull.forge === 'gitlab' ? '/pipelines' : '/checks'}`} target="_blank" rel="noreferrer" aria-label={`Open ${name}`} className="grid size-6 place-items-center text-muted-foreground hover:text-foreground">
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>
              ))}
              {pull.review && (
                <div className="flex items-center gap-2 px-3 py-1.5">
                  {pull.review === 'approved' ? (
                    <CircleCheck className="size-3.5 shrink-0 text-emerald-500" />
                  ) : pull.review === 'changes_requested' ? (
                    <CircleAlert className="size-3.5 shrink-0 text-amber-500" />
                  ) : (
                    <CircleDot className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="flex-1 truncate text-[12px] text-foreground">{REVIEW_WORD[pull.review] || pull.review}</span>
                </div>
              )}
              {pull.mergeable === 'conflicting' && (
                <div className="flex items-center gap-2 px-3 py-1.5">
                  <CircleAlert className="size-3.5 shrink-0 text-rose-500" />
                  <span className="flex-1 truncate text-[12px] text-foreground">Merge conflicts{pull.base ? ` with ${pull.base}` : ''}</span>
                </div>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

// The app ports each session here forwards to this computer, ready to open.
export function PortsTab({ place, state }: { place: Place; state: YardbellState | null }) {
  const rows = sessionsIn(state, place.machine, place.path).flatMap((s) => ((s as Session & { ports?: Port[] }).ports || []).map((p) => ({ p, s })))
  if (!rows.length)
    return (
      <PanelEmpty icon={Plug} title="No forwarded ports">
        When an agent here starts an app, like a dev server on port 3000, Yardbell forwards it to this computer and it shows up here, ready to open.
      </PanelEmpty>
    )
  return (
    <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto p-1">
      {rows.map(({ p, s }) => {
        const url = p.local ? `${location.protocol}//${location.hostname}:${p.local}` : p.url
        return (
          <div key={`${s.id}${p.remote}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent">
            <span
              title={p.status}
              className={cn('size-1.5 shrink-0 rounded-full', p.status === 'tunnel up' || p.status === 'running' ? 'bg-emerald-500' : p.status ? 'bg-amber-500' : 'bg-muted-foreground/40')}
            />
            <span className="min-w-0 flex-1 truncate">{p.service || 'app'}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {p.remote} → {p.local}
            </span>
            {url && (
              <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${p.service}`} className="text-muted-foreground hover:text-foreground">
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>
        )
      })}
    </div>
  )
}
