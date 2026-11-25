import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, LoaderCircle, ChevronsUpDown, Folder, FolderPlus, GitBranch, Home, Search, Server, Settings2, Sparkles, Terminal, Type, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { catalogFor, levelsFor, liveCatalog, type Catalog, type Listed } from '@/lib/agent-models'
import { Hint } from '@/components/ui/tooltip'
import { openShell } from '@/lib/actions'
import { AgentMark } from '@/shell/SessionTree'
import { cn } from '@/lib/class-names'
import { getJson, type Agent, type Project, type YardbellState } from '@/lib/state'
import { short } from '@/lib/tree'

type Entry = { name: string; git?: boolean; branch?: string }
type Listing = { path: string; entries: Entry[]; recent: string[]; git?: boolean; branch?: string; linked?: boolean }
type Branches = { current?: string; local: string[]; remote: string[]; worktrees: Record<string, string>; default_base?: string }
type From = 'smart' | 'branch' | 'name'
type Pick = { kind: 'existing' | 'new'; name: string } | null

export type NewSessionRequest = { machine?: string; path?: string }

const mac = /Mac/.test(navigator.platform)
const api = (m: string) => `/machines/${encodeURIComponent(m)}`
const remembered = (k: string) => {
  try {
    return localStorage.getItem(k) || ''
  } catch {
    return ''
  }
}
const worktreePath = (repo: string, branch: string) => `${repo.replace(/\/$/, '')}-worktrees/${branch.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`
const validBranch = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) && !name.includes('..')
const slug = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
const base = (path: string) => short(path).split('/').filter(Boolean).pop() || short(path)

export const label = 'flex h-5 items-center text-xs font-medium text-muted-foreground'
const trigger =
  'flex h-10 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-background/50 px-3 text-left text-sm outline-none hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:ring-[3px] data-[state=open]:ring-ring/50'
export const option =
  'flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] outline-none hover:bg-black/8 focus-visible:bg-black/8 dark:hover:bg-white/14 dark:focus-visible:bg-white/14'

export type Choice = { agent: string; model: string; effort: string }

function ModelPanel({ agent, catalog, choice, onChoice }: { agent: Agent; catalog: Catalog; choice: Choice; onChoice: (c: Choice) => void }) {
  const [find, setFind] = useState('')
  const mine = choice.agent === agent.name
  const model = mine ? choice.model : ''
  const effort = mine ? choice.effort : ''
  const words = find.trim().toLowerCase()
  const models = catalog.models.filter((m) => !words || `${m.label} ${m.id}`.toLowerCase().includes(words))
  const levels = levelsFor(catalog, model)
  const pickModel = (id: string) => {
    const next = levelsFor(catalog, id)
    onChoice({ agent: agent.name, model: id, effort: next.some((l) => l.value === effort) ? effort : '' })
  }
  return (
    <div className="flex min-h-0 w-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2.5">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={find}
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => e.key !== 'Escape' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.stopPropagation()}
          aria-label="Search models"
          placeholder={`Search ${agent.label} models…`}
          className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
      </div>
      <div className="max-h-56 min-h-0 overflow-y-auto p-1">
        {!words && (
          <DropdownMenuItem onSelect={() => pickModel('')}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">Default</span>
              <span className="truncate text-xs text-muted-foreground">Whatever {agent.label} is set to use</span>
            </span>
            <span className="flex size-3.5 shrink-0 items-center justify-center">{mine && !model && <Check className="size-3.5 text-muted-foreground" />}</span>
          </DropdownMenuItem>
        )}
        {models.map((m) => (
          <DropdownMenuItem key={m.id} onSelect={() => pickModel(m.id)}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{m.label}</span>
              {m.description && <span className="truncate text-xs text-muted-foreground">{m.description}</span>}
            </span>
            <span className="flex size-3.5 shrink-0 items-center justify-center">{model === m.id && <Check className="size-3.5 text-muted-foreground" />}</span>
          </DropdownMenuItem>
        ))}
        {!models.length && <div className="flex h-9 items-center px-2.5 text-xs text-muted-foreground">No models match your search.</div>}
      </div>
      {levels.length > 0 && !words && (
        <div className="flex min-h-9 min-w-0 shrink-0 items-center gap-2 border-t border-border px-2.5 py-1.5">
          <span className="shrink-0 text-xs text-muted-foreground">{catalog.effortLabel}</span>
          <div role="radiogroup" aria-label={catalog.effortLabel} className="flex min-w-0 flex-1 flex-wrap justify-end gap-0.5">
            {levels.map((l) => {
              const on = (effort || catalog.defaultEffort) === l.value
              return (
                <button
                  key={l.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => onChoice({ agent: agent.name, model, effort: l.value === catalog.defaultEffort && !effort ? '' : l.value })}
                  className={cn(
                    'h-6 rounded-md px-2 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    on ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  {l.label}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

const BLANK = 'blank'

function summary(choice: Choice, catalogOf: (agent: string) => Catalog | null) {
  const catalog = catalogOf(choice.agent)
  if (!catalog) return ''
  const model = catalog.models.find((m) => m.id === choice.model)
  const level = levelsFor(catalog, choice.model).find((l) => l.value === choice.effort)
  return [model?.label, level?.label].filter(Boolean).join(' · ')
}

export function AgentPicker({
  agents,
  choice,
  byDefault,
  note,
  catalogOf,
  onChoice,
  onSetDefault,
  onSettings,
  onEnter,
  agentOnly
}: {
  agents: Agent[]
  choice: Choice
  byDefault: string
  note: string
  catalogOf: (agent: string) => Catalog | null
  onChoice: (c: Choice) => void
  onSetDefault?: (name: string) => void
  onSettings?: () => void
  onEnter: () => void
  agentOnly?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [find, setFind] = useState('')
  const results = useRef<HTMLDivElement>(null)
  const words = find.trim().toLowerCase()
  const shown = agents.filter((a) => !words || `${a.label} ${a.name}`.toLowerCase().includes(words))
  const blankShown = !agentOnly && (!words || 'blank terminal'.includes(words))
  const current = agents.find((a) => a.name === choice.agent)
  const detail = summary(choice, catalogOf)
  const withDefault = (name: string, body: React.ReactNode) =>
    agentOnly ? (
      <Fragment key={name}>{body}</Fragment>
    ) : (
      <ContextMenu key={name}>
        <ContextMenuTrigger asChild>{body}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={byDefault === name} onSelect={() => onSetDefault?.(name)}>
            {byDefault === name ? 'Default' : 'Set as default'}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  const label = (a: Agent) => (
    <>
      <AgentMark agent={a.name} />
      <span className="min-w-0 flex-1 truncate">{a.label}</span>
      {choice.agent === a.name && detail && <span className="truncate text-xs text-muted-foreground">{detail}</span>}
      {choice.agent === a.name && <Check className="size-3.5" />}
    </>
  )
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">Agent {!agentOnly && <span className="text-muted-foreground/70">[Optional]</span>}</span>
        {onSettings && (
          <Hint label="Configure agents">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              tabIndex={-1}
              onClick={onSettings}
              aria-label="Open agent settings"
              className="size-5 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
            >
              <Settings2 className="size-3" />
            </Button>
          </Hint>
        )}
      </div>
      <DropdownMenu
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setFind('')
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-label="Select agent"
            className="w-full min-w-0"
            onKeyDown={(e) => {
              if (open) return
              if (e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                onEnter()
              } else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1 && /\S/.test(e.key)) {
                e.preventDefault()
                setFind(e.key)
                setOpen(true)
              }
            }}
          >
            {choice.agent === BLANK ? <Terminal className="size-3.5" /> : current ? <AgentMark agent={current.name} /> : null}
            <span className="min-w-0 flex-1 truncate text-left">
              {choice.agent === BLANK ? 'Blank Terminal' : current?.label || 'Select agent'}
              {detail && <span className="text-muted-foreground"> · {detail}</span>}
            </span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-64">
          <div className="px-1 pt-0.5 pb-1.5">
            <input
              autoFocus
              value={find}
              onChange={(e) => setFind(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') return
                e.stopPropagation()
                if (e.key === 'Enter' || e.key === 'ArrowDown') {
                  e.preventDefault()
                  const first = results.current?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')
                  if (e.key === 'Enter') first?.click()
                  else first?.focus()
                }
              }}
              placeholder="Search agents…"
              className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
          <div ref={results} className="max-h-72 overflow-y-auto">
            {blankShown &&
              withDefault(
                BLANK,
                <DropdownMenuItem className="min-h-9" onSelect={() => onChoice({ agent: BLANK, model: '', effort: '' })}>
                  <Terminal className="size-4" />
                  <span className="min-w-0 flex-1 truncate">Blank Terminal</span>
                  {choice.agent === BLANK && <Check className="size-3.5" />}
                </DropdownMenuItem>
              )}
            {shown.map((a) => {
              const catalog = catalogOf(a.name)
              if (!catalog)
                return withDefault(
                  a.name,
                  <DropdownMenuItem className="min-h-9" onSelect={() => onChoice({ agent: a.name, model: '', effort: '' })}>
                    {label(a)}
                  </DropdownMenuItem>
                )
              return (
                <DropdownMenuSub key={a.name}>
                  {withDefault(
                    a.name,
                    <DropdownMenuSubTrigger className="min-h-9" onClick={() => choice.agent !== a.name && onChoice({ agent: a.name, model: '', effort: '' })}>
                      {label(a)}
                    </DropdownMenuSubTrigger>
                  )}
                  <DropdownMenuSubContent sideOffset={6} collisionPadding={8} className="flex w-104 max-w-[calc(100vw-1rem)] min-w-0 flex-col p-0">
                    <ModelPanel agent={a} catalog={catalog} choice={choice} onChoice={onChoice} />
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )
            })}
            {!blankShown && !shown.length && <DropdownMenuItem disabled>No agents match your search.</DropdownMenuItem>}
          </div>
          {note && <p className="px-2 pt-1.5 pb-1 text-2xs text-muted-foreground">{note}</p>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function Picker({
  icon,
  text,
  children,
  open,
  onOpenChange
}: {
  icon: React.ReactNode
  text: string
  children: React.ReactNode
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" className={trigger}>
          {icon}
          <span className="min-w-0 flex-1 truncate">{text}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="max-h-80 overflow-y-auto">{children}</PopoverContent>
    </Popover>
  )
}

// Yardbell's New session, laid out like Orca's Create worktree: where it runs, what to work from, and which agent.
export function NewSession({
  request,
  state,
  onClose,
  onStarted,
  onOpenSettings
}: {
  request: NewSessionRequest | null
  state: YardbellState | null
  onClose: () => void
  onStarted: (key: string) => void
  onOpenSettings: () => void
}) {
  const up = useMemo(() => (state?.machines || []).filter((m) => m.up).map((m) => m.name), [state])
  const projects = state?.projects || []
  const [machine, setMachine] = useState('')
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<Listing | null>(null)
  const [browseError, setBrowseError] = useState('')
  const [branches, setBranches] = useState<Branches | null>(null)
  const [from, setFrom] = useState<From>('smart')
  const [query, setQuery] = useState('')
  const [pick, setPick] = useState<Pick>(null)
  const [newName, setNewName] = useState('')
  const [newBase, setNewBase] = useState('')
  const [installed, setInstalled] = useState<string[] | null>(null)
  const [agent, setAgent] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [listed, setListed] = useState<Record<string, Listed[]>>({})
  const [defaultAgent, setDefaultAgent] = useState(() => remembered('agent') || (state as { default_agent?: string } | null)?.default_agent || 'claude')
  const [resume, setResume] = useState(false)
  const [more, setMore] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [openPicker, setOpenPicker] = useState<'project' | 'machine' | 'agent' | null>(null)
  const [busy, setBusy] = useState(false)

  const go = (m: string, at: string) => {
    setMachine(m)
    setListing(null)
    setBrowseError('')
    setBranches(null)
    setPick(null)
    setQuery('')
    getJson<Listing>(`${api(m)}/browse${at ? `?path=${encodeURIComponent(at)}` : ''}`)
      .then((l) => {
        setListing(l)
        setPath(l.path)
        if (!l.git) return
        getJson<Branches>(`${api(m)}/branches?path=${encodeURIComponent(l.path)}`)
          .then((b) => {
            setBranches(b)
            setNewBase(b.default_base || b.local[0] || '')
          })
          .catch((e) => toast.error(`Could not read branches: ${e.message}`))
      })
      .catch((e) => setBrowseError(e.message))
  }

  useEffect(() => {
    if (!request) return
    const m = request.machine && up.includes(request.machine) ? request.machine : up[0]
    if (!m) return
    setFrom('smart')
    setNewName('')
    setResume(false)
    setAdvanced(false)
    setBrowsing(false)
    go(m, request.path || projects.find((p) => p.machine === m)?.path || '')
  }, [request])

  useEffect(() => {
    if (!machine) return
    setListed({})
    for (const a of state?.agents || []) {
      if (!catalogFor(a.name) || !/claude/i.test(a.name)) continue
      getJson<{ models: Listed[] | null }>(`${api(machine)}/models?${new URLSearchParams({ agent: a.name })}`)
        .then((r) => r.models?.length && setListed((l) => ({ ...l, [a.name]: r.models! })))
        .catch(() => {})
    }
  }, [machine])

  useEffect(() => {
    if (!machine) return
    setInstalled(null)
    getJson<{ installed: string[] }>(`${api(machine)}/agents`)
      .then((r) => setInstalled(r.installed))
      .catch(() => {})
  }, [machine])

  const agents = state?.agents || []
  const shown = installed ? agents.filter((a) => installed.includes(a.name)) : agents
  const choices = shown.length ? shown : agents
  useEffect(() => {
    const want = [agent, defaultAgent].find((n) => n === BLANK || choices.some((a) => a.name === n))
    const next = want || choices[0]?.name || ''
    if (next !== agent) {
      setModel('')
      setEffort('')
    }
    setAgent(next)
  }, [installed, agents.length])

  const catalogOf = (name: string) => {
    const base = catalogFor(name)
    return base && listed[name] ? liveCatalog(base, listed[name]) : base
  }
  const project = projects.find((p) => p.machine === machine && p.path === path)
  const projectOn = (m: string): Project | undefined =>
    projects.find((p) => p.machine === m && (project ? p.repo === project.repo || p.name === project.name : false))
  const all = branches ? [...branches.local, ...branches.remote].filter((n) => n !== branches.current) : []
  const matches = query ? all.filter((n) => n.toLowerCase().includes(query.toLowerCase())).slice(0, 8) : all.slice(0, 8)
  const exact = all.find((n) => n.toLowerCase() === query.trim().toLowerCase())
  const typed = slug(query)
  const bases = branches
    ? [branches.default_base, ...branches.local, ...branches.remote.map((r) => `origin/${r}`)].filter(
        (v, i, a): v is string => Boolean(v) && a.indexOf(v) === i
      )
    : []

  useEffect(() => {
    if (from !== 'smart') return
    if (!query.trim()) setPick(null)
    else setPick(exact ? { kind: 'existing', name: exact } : typed ? { kind: 'new', name: typed } : null)
  }, [query, exact, typed, from])

  const target: Pick = !listing?.git ? null : from === 'name' ? (validBranch(newName.trim()) ? { kind: 'new', name: newName.trim() } : null) : pick
  const needsPick = listing?.git && from !== 'smart' && !target
  const blank = agent === BLANK
  let where = ''
  if (blank) where = `Opens a plain shell on ${machine}`
  else if (listing) {
    if (!listing.git) where = `Starts in ${short(listing.path)}`
    else if (!target)
      where =
        from === 'smart'
          ? `Stays on ${listing.branch || 'the current branch'} in ${base(listing.path)}`
          : from === 'branch'
            ? 'Pick a branch'
            : 'Enter a branch name'
    else if (target.kind === 'existing')
      where = `Starts on ${target.name} in ${short(branches?.worktrees[target.name] || worktreePath(listing.path, target.name))}`
    else where = `Creates ${target.name} from ${newBase} in ${short(worktreePath(listing.path, target.name))}`
  }
  const ok = Boolean(listing && agent && (blank || !needsPick) && !busy)
  const agentName = agents.find((a) => a.name === agent)?.label || agent
  const starting = blank
    ? `Opening a terminal on ${machine}…`
    : target?.kind === 'new'
      ? `Creating ${target.name}, running its setup, then starting ${agentName}. This can take a minute.`
      : `Starting ${agentName} on ${machine}…`

  const start = async () => {
    if (!ok || !listing) return
    if (blank) {
      setBusy(true)
      const key = await openShell(machine)
      setBusy(false)
      if (!key) return
      onStarted(key)
      if (!more) onClose()
      return
    }
    // The answer comes once the session exists; the machine is checked again in the background,
    // since that check can take many seconds on a slow machine and holds nothing up.
    const body: Record<string, unknown> = { machine, path: listing.path, agent, model, effort, resume, wait: false }
    if (target?.kind === 'existing') body.branch = target.name
    if (target?.kind === 'new') Object.assign(body, { branch: target.name, new_branch: true, base: newBase })
    setBusy(true)
    try {
      const res = await fetch('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body)
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Could not start the session (${res.status})`)
      if (data.setup && !data.setup.ok) toast('The worktree setup failed. The agent started anyway.')
      else toast.success(`Started ${agents.find((a) => a.name === agent)?.label || agent} on ${machine}`)
      onStarted(`${machine}/${data.name}`)
      if (more) {
        setQuery('')
        setNewName('')
        go(machine, listing.path)
      } else onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const addProject = async () => {
    if (!listing) return
    try {
      const res = await fetch('/api/projects/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ machine, path: listing.path })
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Yardbell answered ${res.status}`)
      toast(`Added ${base(listing.path)} to your projects`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const parts = listing ? listing.path.split('/').filter(Boolean) : []

  return (
    <Dialog open={Boolean(request)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex max-h-[calc(100vh-2rem)] flex-col gap-4 overflow-hidden sm:max-w-lg"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (mac ? e.metaKey : e.ctrlKey)) {
            e.preventDefault()
            start()
          }
        }}
      >
        <div className="flex items-center justify-between">
          <DialogTitle className="text-base font-semibold">New session</DialogTitle>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="-mx-1 grid min-h-0 gap-4 overflow-y-auto px-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex h-5 items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">Project</span>
                {listing && !project && (
                  <button
                    type="button"
                    onClick={addProject}
                    title="Add this folder to your projects"
                    aria-label="Add this folder to your projects"
                    className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:text-foreground"
                  >
                    <FolderPlus className="size-3" />
                  </button>
                )}
              </div>
              <Picker
                open={openPicker === 'project'}
                onOpenChange={(o) => setOpenPicker(o ? 'project' : null)}
                icon={<Folder className="size-3.5 shrink-0 text-muted-foreground" />}
                text={listing ? project?.name || base(listing.path) : 'Loading…'}
              >
                {projects.length === 0 && <p className="px-2.5 py-1.5 text-xs text-muted-foreground">No projects yet. Browse to a folder below.</p>}
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setOpenPicker(null)
                      go(p.machine, p.path)
                    }}
                    className={option}
                  >
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{p.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {p.machine} · {short(p.path)}
                      </span>
                    </span>
                    {project?.id === p.id && <Check className="size-3.5" />}
                  </button>
                ))}
                <div className="-mx-[6px] my-[6px] h-px bg-black/7 dark:bg-white/10" />
                <button
                  type="button"
                  onClick={() => {
                    setOpenPicker(null)
                    setAdvanced(true)
                    setBrowsing(true)
                  }}
                  className={option}
                >
                  <Search className="size-3.5 text-muted-foreground" /> Browse folder…
                </button>
              </Picker>
            </div>
            <div className="min-w-0 space-y-1">
              <span className={label}>Run on</span>
              <Picker
                open={openPicker === 'machine'}
                onOpenChange={(o) => setOpenPicker(o ? 'machine' : null)}
                icon={<Server className="size-3.5 shrink-0 text-muted-foreground" />}
                text={machine || '…'}
              >
                {up.map((m) => {
                  const there = m === machine ? path : projectOn(m)?.path
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        setOpenPicker(null)
                        go(m, there || '')
                      }}
                      className={option}
                    >
                      <Server className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className={cn('truncate', m === machine && 'font-medium')}>{m}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {[state?.machines.find((x) => x.name === m)?.local ? 'This computer' : null, there ? short(there) : 'its root folder']
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      {m === machine && <Check className="size-3.5" />}
                    </button>
                  )
                })}
              </Picker>
            </div>
          </div>

          {listing?.git && !blank && (
            <div className="min-w-0 space-y-1">
              <span className={label}>
                Create From&nbsp;<span className="text-muted-foreground/70">[Optional]</span>
              </span>
              <div className="flex items-center gap-4 border-b border-border/40" role="tablist">
                {(
                  [
                    ['smart', 'Smart', Sparkles],
                    ['branch', 'Branch', GitBranch],
                    ['name', 'Name', Type]
                  ] as const
                ).map(([id, text, Icon]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={from === id}
                    onClick={() => {
                      setFrom(id)
                      setPick(null)
                    }}
                    className={cn(
                      'relative -mb-px flex h-8 items-center gap-1.5 text-[13px] outline-none',
                      from === id
                        ? 'text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <Icon className="size-3.5" /> {text}
                  </button>
                ))}
              </div>
              <div className="pt-2">
                {from !== 'name' && (
                  <label className="flex h-10 items-center gap-2 rounded-md border border-input bg-background/50 px-3 focus-within:ring-[3px] focus-within:ring-ring/50">
                    <Search className="size-4 text-muted-foreground" />
                    <input
                      autoFocus
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={from === 'smart' ? 'Search branches, or type a name for a new one' : 'Filter branches'}
                      className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                    />
                  </label>
                )}
                {from === 'name' && (
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <input
                      autoFocus
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="eng-1234-short-description"
                      className="h-10 rounded-md border border-input bg-background/50 px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    />
                    <select
                      value={newBase}
                      onChange={(e) => setNewBase(e.target.value)}
                      aria-label="From"
                      className="h-10 rounded-md border border-input bg-background/50 px-2 text-sm outline-none"
                    >
                      {bases.map((b) => (
                        <option key={b}>{b}</option>
                      ))}
                    </select>
                  </div>
                )}
                {from !== 'name' && (query || from === 'branch') && (
                  <div className="mt-1.5 grid max-h-44 gap-px overflow-y-auto">
                    {from === 'smart' && query.trim() && !exact && typed && (
                      <button
                        type="button"
                        onClick={() => setPick({ kind: 'new', name: typed })}
                        className={cn(option, pick?.kind === 'new' && 'bg-black/8 dark:bg-white/14')}
                      >
                        <Type className="size-3.5 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">
                          New branch <b>{typed}</b> <span className="text-muted-foreground">from {newBase}</span>
                        </span>
                      </button>
                    )}
                    {matches.map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setPick({ kind: 'existing', name: n })}
                        className={cn(option, pick?.kind === 'existing' && pick.name === n && 'bg-black/8 dark:bg-white/14')}
                      >
                        <GitBranch className="size-3.5 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{n}</span>
                        <span className="text-2xs text-muted-foreground">
                          {branches?.worktrees[n] ? 'has a worktree' : branches?.local.includes(n) ? 'local' : 'origin'}
                        </span>
                      </button>
                    ))}
                    {!matches.length && from === 'branch' && <p className="px-2.5 py-1 text-xs text-muted-foreground">No matching branches</p>}
                  </div>
                )}
              </div>
            </div>
          )}

          <AgentPicker
            agents={choices}
            choice={{ agent, model, effort }}
            byDefault={defaultAgent}
            catalogOf={catalogOf}
            onChoice={(c) => {
              setAgent(c.agent)
              setModel(c.model)
              setEffort(c.effort)
            }}
            onSetDefault={(name) => {
              try {
                localStorage.setItem('agent', name)
              } catch {}
              setDefaultAgent(name)
              toast(
                name === BLANK
                  ? 'New sessions start as a blank terminal by default'
                  : `${agents.find((a) => a.name === name)?.label || name} is now your default agent`
              )
            }}
            onSettings={onOpenSettings}
            onEnter={start}
            note={installed && shown.length < agents.length ? `Only agents installed on ${machine} are listed.` : ''}
          />

          <div>
            <button
              type="button"
              onClick={() => setAdvanced((a) => !a)}
              aria-expanded={advanced}
              className="-ml-2 flex h-7 items-center gap-1 rounded-md px-2 text-sm hover:bg-accent"
            >
              Advanced <ChevronDown className={cn('size-4 transition-transform', advanced && 'rotate-180')} />
            </button>
            {advanced && (
              <div className="mt-2 grid gap-3">
                <div className="grid gap-1">
                  <span className={label}>Folder</span>
                  <button type="button" onClick={() => setBrowsing((b) => !b)} aria-expanded={browsing} className={cn(trigger, 'h-8 text-[13px]')}>
                    <Folder className="size-3.5 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{listing ? short(listing.path) : '…'}</span>
                    <ChevronsUpDown className="size-3.5 text-muted-foreground" />
                  </button>
                  {browsing && (
                    <div className="grid gap-1.5 rounded-lg border border-border p-2">
                      {listing && (
                        <nav className="flex flex-wrap items-center gap-0.5 text-xs" aria-label="Folder path">
                          <button type="button" onClick={() => go(machine, '~')} className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent">
                            <Home className="size-3" /> Home
                          </button>
                          {parts.map((p, i) => (
                            <span key={i} className="inline-flex items-center">
                              <span className="text-muted-foreground">/</span>
                              <button
                                type="button"
                                onClick={() => go(machine, `/${parts.slice(0, i + 1).join('/')}`)}
                                className={cn('rounded px-1 py-0.5 hover:bg-accent', i === parts.length - 1 && 'font-medium')}
                              >
                                {p}
                              </button>
                            </span>
                          ))}
                        </nav>
                      )}
                      <ul className="grid max-h-44 gap-px overflow-y-auto">
                        {browseError && <li className="px-2 py-1 text-xs text-destructive">{browseError}</li>}
                        {listing && parts.length > 0 && (
                          <li>
                            <button type="button" onClick={() => go(machine, `/${parts.slice(0, -1).join('/')}`)} className={option}>
                              ..
                            </button>
                          </li>
                        )}
                        {listing?.entries.map((e) => (
                          <li key={e.name}>
                            <button type="button" onClick={() => go(machine, `${listing.path.replace(/\/$/, '')}/${e.name}`)} className={option}>
                              {e.git ? <GitBranch className="size-3.5 text-muted-foreground" /> : <Folder className="size-3.5 text-muted-foreground" />}
                              <span className="min-w-0 flex-1 truncate">{e.name}</span>
                              {e.git && e.branch && <span className="max-w-[40%] min-w-0 shrink-0 truncate font-mono text-2xs text-muted-foreground" title={e.branch}>{e.branch}</span>}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <label className="flex items-center justify-between gap-3 text-[13px]">
                  <span>
                    Continue the last conversation
                    <span className="block text-xs text-muted-foreground">Starts the agent with its resume command.</span>
                  </span>
                  <Switch checked={resume} onCheckedChange={setResume} />
                </label>
              </div>
            )}
          </div>
        </div>

        <div className="grid gap-2">
          <p role="status" className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
            {busy && <LoaderCircle className="size-3 shrink-0 animate-spin" />}
            <span className="truncate">{busy ? starting : where}</span>
          </p>
          <div className="flex items-center justify-between gap-3">
            <label className="group flex cursor-pointer items-center gap-2 text-xs">
              <Switch checked={more} onCheckedChange={setMore} />
              <span className="text-muted-foreground group-hover:text-foreground">Create more</span>
            </label>
            <Button onClick={start} disabled={!ok} aria-busy={busy}>
              {busy ? (
                <>
                  <LoaderCircle className="animate-spin" /> {blank ? 'Opening…' : 'Starting…'}
                </>
              ) : (
                <>
                  {blank ? 'Open terminal' : 'Start session'} <span className="ml-1 text-xs opacity-60">{mac ? '⌘↵' : 'Ctrl+↵'}</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
