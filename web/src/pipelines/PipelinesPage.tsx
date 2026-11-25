import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, ChevronLeft, Clock, GitPullRequest, Hand, Maximize2, MessageSquare, Minimize2, Play, Plus, Repeat, Ticket, Trash2, Webhook } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/class-names'
import { confirmAction } from '@/lib/confirm'
import { PipelineCanvas } from './Canvas'
import { KindIcon } from './icons'
import {
  ago,
  api,
  asksForYou,
  clock,
  counts,
  ENDED,
  flow,
  runLabel,
  setConnectors,
  staying,
  TEMPLATE_HINTS,
  triggerWords,
  type Definition,
  type Listed,
  type PipelinesData,
  type Run
} from './model'
import { RunDot, RunsTab, type RunActions } from './Runs'
import { SettingsView } from './SettingsView'
import { BuildTab, useBuilder } from './Build'
import type { Data } from './Forms'

const POLL = 5000
const FULL_KEY = 'yb-pipeline-full'

function useQuery(): [URLSearchParams, (change: Record<string, string | null>, push?: boolean) => void] {
  const [query, setQueryState] = useState(() => new URLSearchParams(location.search))
  useEffect(() => {
    const back = () => setQueryState(new URLSearchParams(location.search))
    window.addEventListener('popstate', back)
    return () => window.removeEventListener('popstate', back)
  }, [])
  const set = useCallback((change: Record<string, string | null>, push = false) => {
    const q = new URLSearchParams(location.search)
    for (const [k, v] of Object.entries(change)) {
      if (v === null) q.delete(k)
      else q.set(k, v)
    }
    const url = `${location.pathname}${q.toString() ? `?${q}` : ''}`
    if (push) history.pushState(null, '', url)
    else history.replaceState(null, '', url)
    setQueryState(q)
  }, [])
  return [query, set]
}

const tabClass = (active: boolean) =>
  cn(
    '-mb-px flex h-12 items-center gap-1.5 border-b-2 px-2 text-sm transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
    active ? 'border-foreground font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
  )

function Flow({ d }: { d: Definition }) {
  const steps = flow(d)
  if (!steps.length) return <span className="text-xs text-muted-foreground">No steps yet</span>
  return (
    <ol aria-label="Steps" className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-muted-foreground">
      {steps.map((s, i) => (
        <li key={i} className="inline-flex items-center gap-1">
          {i > 0 && <ArrowRight aria-hidden className="size-3 text-muted-foreground/50" />}
          <span className="rounded-md border border-border/70 bg-background px-1.5 py-0.5 text-[11px] text-foreground/80">{s.name}</span>
          {s.loop && (
            <span className="inline-flex items-center gap-0.5 text-muted-foreground" title={`On fail, back to ${s.loop}`}>
              <Repeat className="size-3" /> {s.loop}
            </span>
          )}
        </li>
      ))}
    </ol>
  )
}

function ListView({
  data,
  runs,
  view,
  setView,
  open,
  onNew,
  busy,
  setEnabled,
  reload
}: {
  data: PipelinesData
  runs: Run[]
  view: string
  setView: (v: string) => void
  open: (id: string, run?: string) => void
  onNew: (template: string | null) => void
  busy: boolean
  setEnabled: (d: Definition, on: boolean) => void
  reload: () => Promise<void>
}) {
  const waiting = runs.filter(asksForYou)
  const list = [...data.pipelines].sort((a, b) => Number((b.runs.waiting || 0) > 0) - Number((a.runs.waiting || 0) > 0) || a.definition.name.localeCompare(b.definition.name))
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b border-border/60">
        <div className="flex min-h-12 w-full items-center gap-3 px-3 md:px-5">
          <nav aria-label="Pipelines" className="flex min-w-0 flex-1 items-center gap-1">
            <button type="button" aria-current={view === 'list' ? 'page' : undefined} onClick={() => setView('list')} className={tabClass(view === 'list')}>
              Pipelines <span className="text-xs font-normal text-muted-foreground">{data.pipelines.length}</span>
            </button>
            <button type="button" aria-current={view === 'waiting' ? 'page' : undefined} onClick={() => setView('waiting')} className={tabClass(view === 'waiting')}>
              Waiting for me
              {waiting.length > 0 && <span className="rounded-full bg-status-warning px-1.5 text-[11px] leading-4 font-semibold text-background">{waiting.length}</span>}
            </button>
            <button type="button" aria-current={view === 'settings' ? 'page' : undefined} onClick={() => setView('settings')} className={tabClass(view === 'settings')}>
              Settings
            </button>
          </nav>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" disabled={busy}>
                <Plus /> New pipeline
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              <DropdownMenuLabel>New pipeline · saved switched off</DropdownMenuLabel>
              <DropdownMenuItem className="items-start py-2" onSelect={() => onNew(null)}>
                <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
                  <KindIcon kind="start" className="size-3.5" />
                </span>
                <span className="grid gap-0.5">
                  <span className="font-medium">Empty pipeline</span>
                  <span className="text-[11px] text-muted-foreground">Start with nothing and build it on the canvas</span>
                </span>
              </DropdownMenuItem>
              {data.templates.map((t) => (
                <DropdownMenuItem key={t} className="items-start py-2" onSelect={() => onNew(t)}>
                  <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                    <KindIcon kind="agent" className="size-3.5" />
                  </span>
                  <span className="grid gap-0.5">
                    <span className="font-medium">{t}</span>
                    <span className="text-[11px] text-muted-foreground">{TEMPLATE_HINTS[t] || 'A template'}</span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto">
        <div className="w-full px-3 pt-4 pb-10 md:px-5">
          {view === 'settings' && <SettingsView data={data} onSaved={reload} onCancel={() => setView('list')} />}
          {view === 'waiting' &&
            (waiting.length ? (
              <div className="mx-auto grid max-w-[1200px] gap-2">
                {waiting.map((r) => (
                  <div key={r.id} className="flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.04] px-4 py-3 text-sm">
                    <RunDot run={r} />
                    <button type="button" onClick={() => open(r.pipeline, r.id)} className="grid min-w-0 flex-1 gap-0.5 text-left">
                      <span className="truncate font-medium">{runLabel(r)}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {r.pipeline_name} · {r.waiting?.reason || r.held?.reason || 'Waiting'}
                      </span>
                    </button>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{ago(r.held?.since || r.step_since)}</span>
                    <Button size="sm" variant="outline" onClick={() => open(r.pipeline, r.id)}>
                      Open
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-20 text-center">
                <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
                  <Check className="size-6" />
                </span>
                <p className="text-sm font-medium">Nothing is waiting for you</p>
                <p className="max-w-sm text-xs text-muted-foreground">When a run stops for an approval, an answer or a failed check, it shows up here.</p>
              </div>
            ))}
          {view === 'list' &&
            (list.length ? (
              <div className="mx-auto grid max-w-[1200px] gap-2">
                {list.map((p: Listed) => {
                  const d = p.definition
                  const kind = d.trigger?.kind || 'manual'
                  const TriggerIcon = kind === 'schedule' ? Clock : kind === 'manual' ? Hand : kind === 'webhook' ? Webhook : kind === 'github_review' || kind === 'gitlab_reviewer' ? GitPullRequest : Ticket
                  return (
                    <div
                      key={d.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => open(d.id)}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open(d.id))}
                      className={cn(
                        'grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-xl border bg-card px-4 py-3.5 text-left text-sm transition-colors hover:border-border hover:bg-accent/30 focus-visible:outline-none',
                        p.runs.waiting ? 'border-amber-500/40' : 'border-border/60'
                      )}
                    >
                      <span className={cn('mt-0.5 grid size-9 place-items-center rounded-lg', d.enabled ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground')}>
                        <TriggerIcon className="size-4" />
                      </span>
                      <span className="grid min-w-0 gap-1.5">
                        <span className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate font-medium">{d.name}</span>
                          <span className="shrink-0 rounded-full border border-border px-1.5 text-[10.5px] leading-4 text-muted-foreground">v{d.version}</span>
                          {p.runs.waiting ? (
                            <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 text-[11px] leading-5 font-medium text-amber-700 dark:text-amber-300">
                              {p.runs.waiting} waiting for you
                            </span>
                          ) : null}
                          {p.runs.running ? (
                            <span className="shrink-0 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 text-[11px] leading-5 font-medium text-sky-700 dark:text-sky-300">{p.runs.running} running</span>
                          ) : null}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">{triggerWords(d.trigger)}</span>
                        <Flow d={d} />
                        {p.problem && <span className="truncate text-xs text-destructive">{p.problem}</span>}
                        <span className="text-[11px] text-muted-foreground">{counts(p.runs)}</span>
                      </span>
                      <span onClick={(e) => e.stopPropagation()} className="flex items-center gap-2">
                        <span className={cn('text-xs', d.enabled ? 'text-foreground' : 'text-muted-foreground')}>{d.enabled ? 'On' : 'Off'}</span>
                        <Switch checked={d.enabled} disabled={busy} aria-label={`${d.name} on`} onCheckedChange={(on) => setEnabled(d, on)} />
                      </span>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-20 text-center">
                <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
                  <KindIcon kind="start" className="size-6" />
                </span>
                <p className="text-sm font-medium">No pipelines yet</p>
                <p className="max-w-sm text-xs text-muted-foreground">A pipeline runs agents step by step on a ticket or pull request: plan, implement, review, push, report.</p>
                <div className="mt-2 flex flex-wrap justify-center gap-2">
                  <Button size="sm" onClick={() => onNew(null)}>
                    <Plus /> Empty pipeline
                  </Button>
                  {data.templates.slice(0, 2).map((t) => (
                    <Button key={t} size="sm" variant="outline" onClick={() => onNew(t)}>
                      {t}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}

function RunNowPanel({ d, onClose, onStarted }: { d: Definition; onClose: () => void; onStarted: () => void }) {
  const [subjects, setSubjects] = useState('')
  const [diagrams, setDiagrams] = useState<{ machine: string; folder: string; dir: string }[] | null>(null)
  const [diagram, setDiagram] = useState('')
  const [busy, setBusy] = useState(false)
  const kind = d.trigger.kind
  const linear = kind === 'linear'
  const tool = kind === 'connector'
  const hook = kind === 'webhook'
  const optional = kind === 'manual' || hook
  useEffect(() => {
    if (kind !== 'manual') return
    api<{ diagrams: { machine: string; folder: string; dir: string }[] }>('GET', '/api/diagrams')
      .then((o) => setDiagrams(o.diagrams))
      .catch(() => setDiagrams([]))
  }, [kind])
  const start = async () => {
    setBusy(true)
    try {
      const items = subjects
        .split(/[\s,]+/)
        .map((x) => x.trim())
        .filter(Boolean)
      const body: Record<string, unknown> = tool ? { tickets: items, prs: [] } : { tickets: items.filter((x) => !x.startsWith('https://')), prs: items.filter((x) => x.startsWith('https://')) }
      if (diagram) body.diagram = JSON.parse(diagram)
      const out = await api<{ runs: unknown[] }>('POST', `/api/pipelines/${encodeURIComponent(d.id)}/runs`, body)
      toast(`Started ${out.runs.length} ${out.runs.length === 1 ? 'run' : 'runs'}`)
      onStarted()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const input = 'rounded-md border border-input bg-background px-2 py-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
  return (
    <div className="grid gap-3 border-b border-border bg-muted/30 px-5 py-3">
      {hook ? (
        <p className="text-xs text-muted-foreground">Starts one run with no item.</p>
      ) : (
        <label className="grid gap-1">
          <span className="text-xs font-medium text-muted-foreground">{tool ? 'Item ids or links' : optional ? 'Ticket ids or links (optional)' : linear ? 'Ticket ids' : 'Merge or pull request links'}</span>
          <textarea
            rows={2}
            autoFocus
            value={subjects}
            onChange={(e) => setSubjects(e.target.value)}
            placeholder={tool ? 'abc123' : linear || optional ? 'COM-1234 COM-1240' : 'https://gitlab.example.com/group/app/-/merge_requests/87'}
            className={input}
          />
          <small className="text-[11px] text-muted-foreground">{optional ? 'One run each, or leave it empty for one run with no ticket.' : tool ? 'One run each.' : 'One run each. Ticket ids and links can be mixed.'}</small>
        </label>
      )}
      {optional && !hook && Boolean(diagrams?.length) && (
        <label className="grid gap-1">
          <span className="text-xs font-medium text-muted-foreground">Work from a diagram (optional)</span>
          <select value={diagram} onChange={(e) => setDiagram(e.target.value)} className={cn(input, 'h-8')}>
            <option value="">None</option>
            {diagrams!.map((c) => {
              const v = JSON.stringify({ machine: c.machine, folder: c.folder, dir: c.dir })
              return (
                <option key={v} value={v}>
                  {c.dir.replace(/-\d{8}-\d{6}$/, '').replace(/[-_]+/g, ' ')}, {c.folder} on {c.machine}
                </option>
              )
            })}
          </select>
          <small className="text-[11px] text-muted-foreground">The run keeps its own copy, so drawing again does not change it.</small>
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy || (!optional && !subjects.trim())} onClick={start}>
          <Play /> Start
        </Button>
      </div>
    </div>
  )
}

type Version = { version: number; saved: string; definition: Definition }

function HistoryTab({ d, onChanged }: { d: Definition; onChanged: () => void }) {
  const [versions, setVersions] = useState<Version[]>([])
  const [current, setCurrent] = useState<number | null>(null)
  const [preview, setPreview] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    api<{ history: Version[]; current?: number }>('GET', `/api/pipelines/${encodeURIComponent(d.id)}/history`)
      .then((o) => {
        setVersions(o.history)
        setCurrent(o.current ?? o.history[0]?.version ?? null)
      })
      .catch((e) => toast.error(e.message))
  }, [d.id])
  useEffect(load, [load, d.version])
  const live = versions.find((v) => v.version === current) || versions[0]
  const shown = versions.find((v) => v.version === preview) || live
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await work()
      load()
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const restore = (v: Version) =>
    run(async () => {
      await api('POST', `/api/pipelines/${encodeURIComponent(d.id)}/restore`, { version: v.version })
      setPreview(null)
      toast(`Version ${v.version} is the current one now`)
    })
  const remove = async (v: Version) => {
    if (!(await confirmAction({ title: `Delete version ${v.version}?`, body: "It goes from this pipeline's history. The current version stays as it is.", confirm: 'Delete', danger: true }))) return
    run(() => api('POST', `/api/pipelines/${encodeURIComponent(d.id)}/history/${v.version}/delete`))
  }
  const clear = async () => {
    const n = versions.length - 1
    if (!(await confirmAction({ title: `Delete ${n} older ${n === 1 ? 'version' : 'versions'}?`, body: `Only the current version, v${current}, is kept.`, confirm: 'Delete', danger: true }))) return
    run(() => api('POST', `/api/pipelines/${encodeURIComponent(d.id)}/history/clear`))
  }
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[18rem_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col border-r border-border bg-card/40">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <span className="text-xs font-semibold">Versions</span>
          <span className="text-xs text-muted-foreground tabular-nums">{versions.length}</span>
          <span className="flex-1" />
          {versions.length > 1 && (
            <Button size="xs" variant="ghost" disabled={busy} onClick={clear} className="text-muted-foreground hover:text-destructive" title="Keep only the current version">
              <Trash2 /> Clear older
            </Button>
          )}
        </div>
        <ol className="scrollbar-sleek relative grid min-h-0 content-start overflow-y-auto p-2 before:absolute before:top-6 before:bottom-6 before:left-[22.5px] before:w-px before:bg-border">
          {versions.map((v) => {
            const on = v === shown
            const isLive = v === live
            return (
              <li key={v.version} className="group/v relative flex items-start gap-2.5">
                <span className={cn('relative z-10 mt-3 ml-[10px] size-2.5 shrink-0 rounded-full ring-4 ring-card', isLive ? 'bg-foreground' : 'border-2 border-muted-foreground/50 bg-card')} />
                <div className={cn('mb-1 grid min-w-0 flex-1 gap-1 rounded-lg border px-2.5 py-2 transition-colors', on ? 'border-border bg-background shadow-xs' : 'border-transparent hover:bg-accent/50')}>
                  <button type="button" aria-current={on} onClick={() => setPreview(v.version)} className="grid min-w-0 gap-1 text-left">
                    <span className="flex items-center gap-2 text-[13px]">
                      <span className="font-semibold">v{v.version}</span>
                      {isLive && <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 text-[10px] leading-4 font-medium text-emerald-700 dark:text-emerald-300">Current</span>}
                      <time className="ml-auto text-[11px] text-muted-foreground tabular-nums">{clock(v.saved)}</time>
                    </span>
                    <span className="flex flex-wrap gap-1">
                      {v.definition.steps.length ? (
                        v.definition.steps.slice(0, 5).map((st) => (
                          <span key={st.id} className="rounded border border-border/70 bg-background px-1 text-[10.5px] text-muted-foreground">
                            {st.name}
                          </span>
                        ))
                      ) : (
                        <span className="text-[11px] text-muted-foreground">No steps</span>
                      )}
                      {v.definition.steps.length > 5 && <span className="text-[10.5px] text-muted-foreground">+{v.definition.steps.length - 5}</span>}
                    </span>
                  </button>
                  {!isLive && (
                    <span className="flex gap-1 opacity-0 transition-opacity group-hover/v:opacity-100 focus-within:opacity-100 [[aria-current=true]~&]:opacity-100">
                      <Button size="xs" variant="outline" disabled={busy} onClick={() => restore(v)}>
                        Restore
                      </Button>
                      <Button size="xs" variant="ghost" disabled={busy} onClick={() => remove(v)} className="text-muted-foreground hover:text-destructive">
                        <Trash2 /> Delete
                      </Button>
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      </div>
      {shown ? (
        <PipelineCanvas def={shown.definition} viewKey={`${d.id}:history:${shown.version}`}>
          <div data-own-drag className="absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-xs shadow-xs">
            <span>{shown === live ? `Version ${shown.version}, the current one` : `Version ${shown.version}, saved ${clock(shown.saved)}`}</span>
            {shown !== live && (
              <>
                <Button size="xs" variant="outline" onClick={() => restore(shown)}>
                  Restore
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setPreview(null)}>
                  Back to the current version
                </Button>
              </>
            )}
          </div>
        </PipelineCanvas>
      ) : (
        <div />
      )}
    </div>
  )
}

type ProposalInfo = { key: string; before?: unknown; decided: boolean; url: string; back: [string, string]; by: string; def: Definition }

// A key is "<conversation>.<step>" for a Dispatch step, or "inbox.<id>" for a proposal from an MCP client.
async function loadProposal(key: string): Promise<ProposalInfo | null> {
  const at = key.lastIndexOf('.')
  const conversation = key.slice(0, at)
  const step = key.slice(at + 1)
  const inbox = conversation === 'inbox'
  type Action = { tool: string; id?: string; role?: string; status?: string; from?: string; input: { definition: Definition; before?: unknown } }
  const e: Action | null | undefined = inbox
    ? await api<Action>('GET', `/api/proposals/${encodeURIComponent(step)}`).then(
        (p) => (p.tool === 'save_pipeline' ? p : null),
        () => null
      )
    : (await api<{ events: Action[] }>('GET', `/dispatch/conversations/${encodeURIComponent(conversation)}`)).events.find((x) => x.role === 'action' && x.id === step && x.tool === 'save_pipeline')
  if (!e) return null
  return {
    key,
    before: e.input.before,
    decided: e.status !== 'pending',
    url: inbox ? `/api/proposals/${encodeURIComponent(step)}` : `/dispatch/conversations/${encodeURIComponent(conversation)}/actions/${step}`,
    back: inbox ? ['/proposals', 'Proposals'] : [`/dispatch?c=${encodeURIComponent(conversation)}`, 'Dispatch'],
    by: inbox ? e.from || 'an MCP client' : 'Dispatch',
    def: e.input.definition
  }
}

function ProposalView({ keyName, data, onDone, onBack }: { keyName: string; data: PipelinesData; onDone: (id: string) => void; onBack: (href: string) => void }) {
  const [p, setP] = useState<ProposalInfo | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    loadProposal(keyName).then(setP, () => setP(null))
  }, [keyName])
  const b = useBuilder(p?.def)
  if (p === undefined) return <div className="grid h-full place-items-center text-sm text-muted-foreground">Loading the proposal…</div>
  if (!p || !b) return <div className="grid h-full place-items-center text-sm text-muted-foreground">There is no such proposal.</div>
  const approve = async () => {
    setBusy(true)
    try {
      const edited = JSON.stringify(b.draft) !== JSON.stringify(p.def)
      const step = await api<{ result?: { ok: boolean; text: string } }>('POST', p.url, { decision: 'approve', ...(edited ? { input: { definition: b.draft, before: p.before } } : {}) })
      if (step.result && !step.result.ok) {
        setP({ ...p, decided: true })
        toast.error(step.result.text)
        return
      }
      const out = JSON.parse(step.result?.text || '{}')
      toast(`Saved as v${out.version}`)
      onDone(out.saved)
    } catch (e) {
      const msg = (e as Error).message
      if (/already|withdrawn/.test(msg)) {
        setP({ ...p, decided: true })
        toast.error(msg)
        return
      }
      const listed = msg.match(/send the whole pipeline again: (.*)$/s)
      if (!listed) toast.error(msg)
      else b.setProblems(listed[1].split('; '))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <Button size="sm" variant="ghost" onClick={() => onBack(p.back[0])} className="text-muted-foreground">
          <ChevronLeft /> {p.back[1]}
        </Button>
        <input
          aria-label="Pipeline name"
          value={b.draft.name}
          disabled={p.decided}
          onChange={(e) => b.update((d) => (d.name = e.target.value))}
          className="h-8 w-64 min-w-0 rounded-md border border-transparent bg-transparent px-2 text-[15px] font-semibold outline-none hover:border-input focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <span className="flex-1" />
        {!p.decided && (
          <Button size="sm" disabled={busy} onClick={approve}>
            <Check /> Approve and save
          </Button>
        )}
      </header>
      <p role="status" className="border-b border-border/60 bg-muted/40 px-5 py-2 text-xs text-muted-foreground">
        {p.decided ? 'This proposal was already decided.' : `Proposed by ${p.by}. Saving approves it.`}
      </p>
      <BuildTab b={b} data={data as Data} viewKey={`proposal:${p.key}`} proposal decided={p.decided} onSave={approve} />
    </div>
  )
}

export function PipelinesPage({ onDispatch }: { onDispatch: (prompt: string) => void }) {
  const [query, setQuery] = useQuery()
  const [data, setData] = useState<PipelinesData | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [runNow, setRunNow] = useState(false)
  const [full, setFull] = useState(() => localStorage.getItem(FULL_KEY) === 'true')
  const busyRef = useRef(false)
  busyRef.current = busy

  const load = useCallback(async () => {
    try {
      const [list, all] = await Promise.all([api<PipelinesData>('GET', '/api/pipelines'), api<{ runs: Run[] }>('GET', '/api/runs')])
      setConnectors(list.connectors)
      setData(list)
      setRuns(all.runs)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(() => !document.hidden && !busyRef.current && load(), POLL)
    return () => clearInterval(t)
  }, [load])

  const id = query.get('p')
  const def = id ? data?.pipelines.find((p) => p.definition.id === id)?.definition : undefined
  const b = useBuilder(def)
  const unsaved = Boolean(def && b && JSON.stringify(b.draft) !== JSON.stringify(def))
  const unsavedRef = useRef(unsaved)
  unsavedRef.current = unsaved
  useEffect(() => {
    const stay = (e: BeforeUnloadEvent) => {
      if (!unsavedRef.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', stay)
    return () => window.removeEventListener('beforeunload', stay)
  }, [])
  const leave = async () => !unsavedRef.current || (await confirmAction({ title: 'Leave without saving your changes?', body: 'Your changes to this pipeline are lost.', confirm: 'Leave', danger: true }))
  useEffect(() => setRunNow(false), [id])

  const doing = async (work: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await work()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
      await load()
    }
  }

  const setEnabled = (d: Definition, on: boolean) => doing(() => api('POST', `/api/pipelines/${encodeURIComponent(d.id)}/enabled`, { enabled: on }))
  const open = (pid: string, run?: string) => setQuery({ p: pid, run: run || null, step: null, tab: run ? 'runs' : null, view: null }, true)
  const onNew = (template: string | null) =>
    doing(async () => {
      const d = await api<{ id: string }>('POST', '/api/pipelines', template ? { template } : { empty: true })
      setQuery({ p: d.id, tab: 'build', run: null, step: null }, true)
    })

  if (!data)
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : (
          'Loading pipelines…'
        )}
      </div>
    )

  const proposalKey = query.get('proposal')
  if (proposalKey)
    return (
      <ProposalView
        keyName={proposalKey}
        data={data}
        onDone={(saved) => setQuery({ proposal: null, p: saved, tab: 'build' }, true)}
        onBack={(href) => window.parent.postMessage({ yardbell: 'go', href }, location.origin)}
      />
    )

  if (!id || !def || !b)
    return (
      <ListView
        data={data}
        runs={runs}
        view={query.get('view') || 'list'}
        setView={(v) => setQuery({ view: v === 'list' ? null : v })}
        open={open}
        onNew={onNew}
        busy={busy}
        setEnabled={setEnabled}
        reload={load}
      />
    )

  const mine = runs.filter((r) => r.pipeline === def.id)
  const tab = query.get('tab') || (mine.length ? 'runs' : 'build')

  const actions: RunActions = {
    busy,
    act: (run, what, body) => doing(() => api('POST', `/api/runs/${encodeURIComponent(run.id)}/${what}`, body || {})),
    removeRun: async (run) => {
      if (!(await confirmAction({ title: 'Delete this run?', body: `Its record goes: the step results, reports and history shown here.\n${staying([run])}`, confirm: 'Delete', danger: true }))) return
      doing(async () => {
        await api('DELETE', `/api/runs/${encodeURIComponent(run.id)}`)
        setQuery({ run: null, step: null })
      })
    },
    clearRuns: async () => {
      const ended = mine.filter((r) => ENDED.includes(r.state))
      const n = ended.length
      if (
        !(await confirmAction({
          title: `Delete ${n} finished ${n === 1 ? 'run' : 'runs'}?`,
          body: `${n === 1 ? 'Its record goes' : 'Their records go'}: the step results, reports and history. Runs still queued, running or waiting are kept.\n${staying(ended)}`,
          confirm: 'Delete',
          danger: true
        }))
      )
        return
      doing(async () => {
        const out = await api<{ deleted: string[] }>('POST', `/api/pipelines/${encodeURIComponent(def.id)}/clear-runs`)
        if (out.deleted.includes(query.get('run') || '')) setQuery({ run: null, step: null })
        toast(`Deleted ${out.deleted.length} finished ${out.deleted.length === 1 ? 'run' : 'runs'}`)
      })
    },
    stopSession: async (run, t) => {
      if (!(await confirmAction({ title: `Stop ${t.name}?`, body: t.current ? 'The agent in it stops. The step then waits for you.' : 'The agent in it stops.', confirm: 'Stop session', danger: true }))) return
      doing(() => api('POST', `/api/runs/${encodeURIComponent(run.id)}/stop-session`, { name: t.name }))
    }
  }

  const remove = async () => {
    const going = mine.filter((r) => !ENDED.includes(r.state)).length
    if (going) {
      toast.error(`${def.name} has ${going} ${going === 1 ? 'run' : 'runs'} still queued, running or waiting. Drop ${going === 1 ? 'it' : 'them'} first.`)
      return
    }
    if (!(await confirmAction({ title: `Delete ${def.name} and its runs?`, body: `Its versions and its finished runs' records go.\n${staying(mine)}`, confirm: 'Delete', danger: true }))) return
    doing(async () => {
      await api('DELETE', `/api/pipelines/${encodeURIComponent(def.id)}`)
      setQuery({ p: null, tab: null, run: null, step: null }, true)
    })
  }

  const startRun = () => {
    if (def.trigger.kind === 'schedule')
      return doing(async () => {
        await api('POST', `/api/pipelines/${encodeURIComponent(def.id)}/runs`, {})
        toast('Started')
      })
    setRunNow((o) => !o)
  }

  const save = () =>
    doing(async () => {
      try {
        const saved = await api<Definition>('PUT', `/api/pipelines/${encodeURIComponent(def.id)}`, b.draft)
        b.reset(saved)
        b.setProblems([])
        toast(`Saved as v${saved.version}`)
      } catch (e) {
        const problems = (e as Error & { problems?: string[] }).problems
        if (!problems?.length) throw e
        b.setProblems(problems)
        setQuery({ tab: 'build' })
      }
    })

  const tabs: [string, string][] = [
    ['build', 'Build'],
    ['runs', mine.length ? `Runs ${mine.length}` : 'Runs'],
    ['history', 'History']
  ]

  return (
    <div className={cn('flex min-h-0 flex-col bg-background', full ? 'fixed inset-0 z-40' : 'h-full')}>
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <Button size="sm" variant="ghost" onClick={async () => (await leave()) && setQuery({ p: null, tab: null, run: null, step: null }, true)} className="text-muted-foreground">
          <ChevronLeft /> Pipelines
        </Button>
        <input
          aria-label="Pipeline name"
          value={b.draft.name}
          onChange={(e) => b.update((d) => (d.name = e.target.value))}
          onKeyDown={(e) => e.key === 'Enter' && unsaved && save()}
          className="h-8 w-56 min-w-0 rounded-md border border-transparent bg-transparent px-2 text-[15px] font-semibold outline-none hover:border-input focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <Switch checked={def.enabled} disabled={busy} aria-label={`${def.name} on`} onCheckedChange={(on) => setEnabled(def, on)} />
        <span className="text-xs text-muted-foreground">v{def.version}</span>
        <nav role="tablist" className="ml-2 flex items-center gap-1 self-stretch">
          {tabs.map(([t, l]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setQuery({ tab: t, step: null })} className={tabClass(tab === t)}>
              {l}
            </button>
          ))}
        </nav>
        <span className="flex-1" />
        <Button size="icon-sm" variant="ghost" aria-pressed={full} aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen' : 'Full screen'} onClick={() => {
          setFull((f) => {
            localStorage.setItem(FULL_KEY, String(!f))
            return !f
          })
        }} className="text-muted-foreground">
          {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </Button>
        <Button size="sm" variant="ghost" onClick={async () => (await leave()) && onDispatch(`Change the pipeline "${def.name}" (${def.id}): `)} className="text-muted-foreground">
          <MessageSquare /> Ask Dispatch
        </Button>
        <Button size="sm" variant="ghost-destructive" onClick={remove}>
          <Trash2 /> Delete
        </Button>
        <Button size="sm" variant="outline" disabled={busy} aria-expanded={runNow} onClick={startRun}>
          <Play /> Run now
        </Button>
        {unsaved ? (
          <Button size="sm" disabled={busy} onClick={save}>
            Save
          </Button>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 text-xs text-muted-foreground">
            <Check className="size-3.5" /> Saved
          </span>
        )}
      </header>
      {runNow && (
        <RunNowPanel
          d={def}
          onClose={() => setRunNow(false)}
          onStarted={() => {
            setRunNow(false)
            setQuery({ tab: 'runs', run: null, step: null })
            load()
          }}
        />
      )}
      {tab === 'runs' ? (
        <RunsTab d={def} runs={mine} data={data} query={query} setQuery={setQuery} a={actions} />
      ) : tab === 'history' ? (
        <HistoryTab d={def} onChanged={load} />
      ) : (
        <BuildTab b={b} data={data as Data} viewKey={`${def.id}:build`} onSave={save} />
      )}
    </div>
  )
}
