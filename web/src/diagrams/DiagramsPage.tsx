import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronLeft, GitBranch, Home, Search, FileCode, Folder, FolderPlus, Lightbulb, MoreHorizontal, Network, Plus, RefreshCw, Server, Trash2, Workflow, X } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { later } from '@/components/ui/menu-items'
import { AgentPicker, label, option, Picker, type Choice } from '@/workspace/NewSession'
import { catalogFor, liveCatalog, type Listed } from '@/lib/agent-models'
import { getJson, type Project } from '@/lib/state'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/class-names'
import { confirmAction } from '@/lib/confirm'
import { api } from '@/pipelines/model'

type Listing = { path: string; entries: { name: string; git?: boolean; branch?: string }[] }
type MachineInfo = {
  name: string
  state: 'installed' | 'not_installed' | 'needs_node' | 'offline'
  problem?: string
  folders: string[]
  paths?: Record<string, string>
}
type Diagram = { machine: string; folder: string; dir: string; file: string; modified: number }
type Data = { version: string; machines: MachineInfo[]; diagrams: Diagram[]; agents: { name: string; label: string }[]; default_agent: string }

const WORDS: Record<string, string> = {
  installed: 'Installed',
  not_installed: 'Not installed',
  needs_node: 'Needs Node 18 or later',
  offline: 'Did not answer'
}
const NEW_FOLDER = '__new'
const TEMPLATE = 'Implement from a diagram'

const titleOf = (d: Diagram) => d.dir.replace(/-\d{8}-\d{6}$/, '').replace(/[-_]+/g, ' ')
const when = (s: number) => new Date(s * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
const viewUrl = (d: Diagram) => `/diagrams/view?${new URLSearchParams({ machine: d.machine, folder: d.folder, dir: d.dir, file: d.file })}`

const input =
  'h-8 w-full rounded-md border border-input bg-background px-2 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <small className="text-[11.5px] text-muted-foreground">{hint}</small>}
    </label>
  )
}

const shortPath = (p: string) => p.replace(/^\/(home|Users)\/[^/]+/, '~')
const baseName = (p: string) => p.split('/').filter(Boolean).pop() || p
const mac = /Mac/.test(navigator.platform)

function DrawDialog({
  data,
  projects,
  start,
  onClose,
  onStarted
}: {
  data: Data
  projects: Project[]
  start: { machine?: string; folder?: string }
  onClose: () => void
  onStarted: (machine: string, name: string) => void
}) {
  const ready = data.machines.filter((m) => m.state === 'installed')
  const first = ready.find((m) => m.name === start.machine) || ready[0]
  const [machine, setMachine] = useState(first?.name || '')
  const [folder, setFolder] = useState(start.folder && first?.folders.includes(start.folder) ? start.folder : first?.folders[0] || '')
  const [choice, setChoice] = useState<Choice>({ agent: data.default_agent, model: '', effort: '' })
  const agent = choice.agent
  const [installed, setInstalled] = useState<string[] | null>(null)
  const [listed, setListed] = useState<Record<string, Listed[]>>({})
  const [kind, setKind] = useState<'code' | 'description'>('code')
  const [text, setText] = useState('')
  const [where, setWhere] = useState(start.folder ? start.folder : NEW_FOLDER)
  const [newFolder, setNewFolder] = useState('')
  const [picker, setPicker] = useState<'machine' | 'folder' | 'where' | null>(null)
  const [find, setFind] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [listing, setListing] = useState<Listing | null>(null)
  const [browseError, setBrowseError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const m = data.machines.find((x) => x.name === machine)
  const fresh = kind === 'description' && where === NEW_FOLDER
  const ok = !busy && (kind === 'code' ? Boolean(folder) : Boolean(text.trim()) && (fresh ? /^[A-Za-z0-9._-]+$/.test(newFolder.trim()) : Boolean(where)))
  const agentLabel = data.agents.find((a) => a.name === agent)?.label || agent
  const agents = installed ? data.agents.filter((a) => installed.includes(a.name)) : data.agents
  const catalogOf = (name: string) => {
    const base = catalogFor(name)
    return base && listed[name] ? liveCatalog(base, listed[name]) : base
  }

  useEffect(() => {
    if (!machine) return
    const at = `/machines/${encodeURIComponent(machine)}`
    setInstalled(null)
    setListed({})
    getJson<{ installed: string[] }>(`${at}/agents`)
      .then((r) => setInstalled(r.installed))
      .catch(() => {})
    for (const a of data.agents) {
      if (!catalogFor(a.name) || !/claude/i.test(a.name)) continue
      getJson<{ models: Listed[] | null }>(`${at}/models?${new URLSearchParams({ agent: a.name })}`)
        .then((r) => r.models?.length && setListed((l) => ({ ...l, [a.name]: r.models! })))
        .catch(() => {})
    }
  }, [machine])
  useEffect(() => {
    if (installed && !installed.includes(agent) && agents[0]) setChoice({ agent: agents[0].name, model: '', effort: '' })
  }, [installed])

  const submit = async () => {
    if (!ok) return
    setBusy(true)
    setError('')
    try {
      const described = kind === 'description'
      const started = await api<{ machine: string; name: string }>('POST', '/api/diagrams/draw', {
        machine,
        agent,
        model: choice.model,
        effort: choice.effort,
        folder: fresh ? '' : described ? where : folder,
        new_folder: fresh ? newFolder.trim() : '',
        description: described ? text.trim() : '',
        focus: described ? '' : text.trim()
      })
      onStarted(started.machine, started.name)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const pathOf = (m: string, f: string) => data.machines.find((x) => x.name === m)?.paths?.[f] || f
  const everyFolder = ready.flatMap((x) => x.folders.map((f) => ({ machine: x.name, folder: f, name: baseName(pathOf(x.name, f)), path: pathOf(x.name, f) })))
  const projectFolders = projects.flatMap((p) => {
    const hit = everyFolder.find((f) => f.machine === p.machine && f.path === p.path)
    return hit ? [{ ...hit, name: p.name }] : []
  })
  useEffect(() => {
    if (start.folder || !projectFolders.length) return
    const p = projectFolders.find((x) => x.machine === (start.machine || ready[0]?.name)) || projectFolders[0]
    setMachine(p.machine)
    setFolder(p.folder)
  }, [])
  const nameOf = (m: string, f: string) => projectFolders.find((p) => p.machine === m && p.folder === f)?.name || baseName(pathOf(m, f))
  const sameOn = (m: string, f: string) => {
    const there = data.machines.find((x) => x.name === m)?.folders || []
    return there.includes(f) ? f : there.find((x) => baseName(x) === baseName(f)) || ''
  }
  const browse = (m: string, at: string) => {
    setBrowsing(true)
    setBrowseError('')
    getJson<Listing>(`/machines/${encodeURIComponent(m)}/browse${at ? `?path=${encodeURIComponent(at)}` : ''}`)
      .then((l) => {
        setListing(l)
        if (kind === 'code') setFolder(l.path)
        else setWhere(l.path)
      })
      .catch((e) => setBrowseError(e.message))
  }
  const parts = listing ? listing.path.split('/').filter(Boolean) : []

  const projectList = (chosen: string, choose: (m: string, f: string) => void, withNew?: boolean) => {
    const words = find.trim().toLowerCase()
    const all = !projectFolders.length
    const shown = (all ? everyFolder : projectFolders).filter((p) => !words || `${p.name} ${p.path} ${p.machine}`.toLowerCase().includes(words))
    const name = newFolder.trim()
    const nameOk = /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith('.')
    return (
      <div className="grid gap-0.5">
        {all && (
          <div className="sticky -top-1.5 z-10 -mx-1.5 -mt-1.5 mb-1 border-b border-border/50 bg-popover p-1.5">
            <label className="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background/50 px-2 focus-within:ring-[3px] focus-within:ring-ring/50">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder="Search folders…"
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              />
            </label>
          </div>
        )}
        {shown.map((p) => (
          <button key={`${p.machine}:${p.folder}`} type="button" className={option} onClick={() => choose(p.machine, p.folder)} title={p.path}>
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{p.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {p.machine} · {shortPath(p.path)}
              </span>
            </span>
            {chosen === p.folder && machine === p.machine && <Check className="size-3.5" />}
          </button>
        ))}
        {!shown.length && <p className="px-2.5 py-1.5 text-xs text-muted-foreground">{words ? 'No folder matches.' : 'No folders yet.'}</p>}
        <div className="-mx-[6px] my-[6px] h-px bg-black/7 dark:bg-white/10" />
        <button
          type="button"
          onClick={() => (setPicker(null), browse(machine, chosen && chosen !== NEW_FOLDER ? pathOf(machine, chosen) : ''))}
          className={option}
        >
          <Search className="size-3.5 text-muted-foreground" /> Browse folder…
        </button>
        {withNew && (
          <>
            <div className="-mx-[6px] my-[6px] h-px bg-black/7 dark:bg-white/10" />
            <form
              className="flex items-center gap-2 px-2.5 py-1"
              onSubmit={(e) => {
                e.preventDefault()
                if (!nameOk) return
                setWhere(NEW_FOLDER)
                setPicker(null)
              }}
            >
              <FolderPlus className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                autoCapitalize="off"
                spellCheck={false}
                placeholder={`New folder on ${machine}`}
                aria-label="New folder name"
                className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background/50 px-2 text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
              <Button type="submit" size="xs" disabled={!nameOk}>
                Use
              </Button>
            </form>
            <p className="px-2.5 pb-1 text-[11px] text-muted-foreground">Made as a new git repository in {machine}'s folder for projects.</p>
          </>
        )}
      </div>
    )
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex max-h-[calc(100vh-2rem)] flex-col gap-5 overflow-y-auto sm:max-w-xl"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (mac ? e.metaKey : e.ctrlKey)) {
            e.preventDefault()
            submit()
          }
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-1">
            <DialogTitle className="text-base font-semibold">New diagram</DialogTitle>
            <DialogDescription className="text-xs">An agent draws it with Archify in a session you can watch or stop.</DialogDescription>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div role="radiogroup" aria-label="What to draw from" className="grid grid-cols-2 gap-2">
          {(
            [
              ['code', FileCode, 'From code', 'Map a folder that already exists'],
              ['description', Lightbulb, 'From an idea', 'Describe it, and get a plan to build from']
            ] as const
          ).map(([k, Icon, title, help]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => (setKind(k), setText(''))}
              className={cn(
                'flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors',
                kind === k ? 'border-foreground/70 bg-accent/60 ring-2 ring-foreground/10' : 'border-border hover:border-foreground/30 hover:bg-accent/30'
              )}
            >
              <Icon className={cn('mt-0.5 size-4 shrink-0', kind === k ? 'text-foreground' : 'text-muted-foreground')} />
              <span className="grid gap-0.5">
                <span className="text-[13px] font-medium">{title}</span>
                <span className="text-[11.5px] leading-snug text-muted-foreground">{help}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="grid gap-1.5">
          <span className={label}>{kind === 'code' ? 'What to focus on' : 'What to draw'}</span>
          <textarea
            key={kind}
            autoFocus
            rows={browsing ? 2 : 4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              kind === 'code'
                ? 'Leave empty to map the whole repository, or name a part, like the billing flow'
                : 'A shop with a cart, Stripe payments, an admin page and a nightly stock import'
            }
            className="w-full resize-none rounded-md border border-input bg-background/50 px-3 py-2.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/70 focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </div>

        <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
          <div className="min-w-0 space-y-1">
            <span className={label}>{kind === 'code' ? 'Project' : 'Save it in'}</span>
            {kind === 'code' ? (
              <Picker
                icon={<Folder className="size-3.5 shrink-0 text-muted-foreground" />}
                text={folder ? nameOf(machine, folder) : 'No folders yet'}
                open={picker === 'folder'}
                onOpenChange={(o) => (setFind(''), setPicker(o ? 'folder' : null))}
              >
                {projectList(folder, (m, f) => (setMachine(m), setFolder(f), setPicker(null)))}
              </Picker>
            ) : (
              <Picker
                icon={
                  where === NEW_FOLDER ? (
                    <FolderPlus className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                  )
                }
                text={where === NEW_FOLDER ? (newFolder.trim() ? `New: ${newFolder.trim()}` : 'Name a new folder') : nameOf(machine, where)}
                open={picker === 'where'}
                onOpenChange={(o) => (setFind(''), setPicker(o ? 'where' : null))}
              >
                {projectList(where, (m, f) => (setMachine(m), setWhere(f), setPicker(null)), true)}
              </Picker>
            )}
          </div>
          <div className="min-w-0 space-y-1">
            <span className={label}>Run on</span>
            <Picker
              icon={<Server className="size-3.5 shrink-0 text-muted-foreground" />}
              text={machine || 'No machine has Archify'}
              open={picker === 'machine'}
              onOpenChange={(o) => setPicker(o ? 'machine' : null)}
            >
              {data.machines.map((x) => {
                const usable = x.state === 'installed'
                const there = kind === 'code' ? sameOn(x.name, folder) || x.folders[0] : where === NEW_FOLDER ? '' : sameOn(x.name, where)
                return (
                  <button
                    key={x.name}
                    type="button"
                    disabled={!usable}
                    className={cn(option, 'disabled:opacity-50')}
                    onClick={() => {
                      setMachine(x.name)
                      if (browsing) browse(x.name, '')
                      else if (kind === 'code') setFolder(there || '')
                      else if (where !== NEW_FOLDER) setWhere(there || NEW_FOLDER)
                      setPicker(null)
                    }}
                  >
                    <Server className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={cn('truncate', x.name === machine && 'font-medium')}>{x.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {usable ? (there ? shortPath(there) : 'its folder for projects') : WORDS[x.state]}
                      </span>
                    </span>
                    {x.name === machine && <Check className="size-3.5" />}
                  </button>
                )
              })}
            </Picker>
          </div>
          {browsing && (
            <div className="col-span-full grid gap-1.5 rounded-lg border border-border p-2">
              <div className="flex items-center gap-2">
                {listing && (
                  <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-xs" aria-label="Folder path">
                    <button type="button" onClick={() => browse(machine, '~')} className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent">
                      <Home className="size-3" /> Home
                    </button>
                    {parts.map((p, i) => (
                      <span key={i} className="inline-flex items-center">
                        <span className="text-muted-foreground">/</span>
                        <button
                          type="button"
                          onClick={() => browse(machine, `/${parts.slice(0, i + 1).join('/')}`)}
                          className={cn('rounded px-1 py-0.5 hover:bg-accent', i === parts.length - 1 && 'font-medium')}
                        >
                          {p}
                        </button>
                      </span>
                    ))}
                  </nav>
                )}
                <button
                  type="button"
                  aria-label="Close the folder browser"
                  onClick={() => setBrowsing(false)}
                  className="ml-auto grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <ul className="grid max-h-44 gap-px overflow-y-auto">
                {browseError && <li className="px-2 py-1 text-xs text-destructive">{browseError}</li>}
                {listing && parts.length > 0 && (
                  <li>
                    <button type="button" onClick={() => browse(machine, `/${parts.slice(0, -1).join('/')}`)} className={option}>
                      ..
                    </button>
                  </li>
                )}
                {listing?.entries.map((e) => (
                  <li key={e.name}>
                    <button type="button" onClick={() => browse(machine, `${listing.path.replace(/\/$/, '')}/${e.name}`)} className={option}>
                      {e.git ? <GitBranch className="size-3.5 text-muted-foreground" /> : <Folder className="size-3.5 text-muted-foreground" />}
                      <span className="min-w-0 flex-1 truncate">{e.name}</span>
                      {e.git && e.branch && <span className="max-w-[40%] min-w-0 shrink-0 truncate font-mono text-2xs text-muted-foreground" title={e.branch}>{e.branch}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="col-span-full">
            <AgentPicker
              agentOnly
              agents={agents.length ? agents : data.agents}
              choice={choice}
              byDefault={data.default_agent}
              catalogOf={catalogOf}
              onChoice={setChoice}
              onEnter={submit}
              note={installed && agents.length < data.agents.length ? `Only agents installed on ${machine} are listed.` : ''}
            />
          </div>
        </div>

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <div className="sticky -bottom-6 z-10 -mx-6 -mb-6 flex items-center gap-3 border-t border-border/60 bg-background px-6 pt-4 pb-6">
          <p className="min-w-0 flex-1 text-[11.5px] leading-snug text-muted-foreground">
            Uses {agentLabel}'s tokens. The diagram shows what the agent read, so check it before sharing.
          </p>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ok} onClick={submit}>
            {busy ? 'Starting…' : 'Draw'}
            <kbd className="ml-1 rounded bg-primary-foreground/15 px-1 font-sans text-[10px]">{mac ? '⌘↵' : 'Ctrl ↵'}</kbd>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function BuildDialog({ d, onClose, onStarted }: { d: Diagram; onClose: () => void; onStarted: (id: string) => void }) {
  const [list, setList] = useState<{ id: string; name: string }[] | null>(null)
  const [pick, setPick] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api<{ pipelines: { definition: { id: string; name: string; trigger?: { kind: string }; steps?: unknown[] } }[] }>('GET', '/api/pipelines')
      .then(({ pipelines }) => {
        const usable = (pipelines || []).map((p) => p.definition).filter((p) => p.trigger?.kind === 'manual' && p.steps?.length)
        setList(usable)
        setPick((usable.find((p) => p.name === TEMPLATE) || usable[0])?.id || '')
      })
      .catch((e) => setError(e.message))
  }, [])
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      let id = pick
      if (!id) id = (await api<{ id: string }>('POST', '/api/pipelines', { template: TEMPLATE })).id
      await api('POST', `/api/pipelines/${encodeURIComponent(id)}/runs`, { diagram: { machine: d.machine, folder: d.folder, dir: d.dir } })
      onStarted(id)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-4 sm:max-w-lg">
        <DialogTitle>Build from {titleOf(d)}</DialogTitle>
        <DialogDescription className="text-xs">
          A run takes its own copy of this diagram and uses your agents' tokens. <strong>{TEMPLATE}</strong> writes a task list and waits for you to approve it
          before changing any code. A pipeline you made yourself only waits where you told it to.
        </DialogDescription>
        {list === null ? (
          <p className="text-xs text-muted-foreground">Reading your pipelines…</p>
        ) : list.length ? (
          <Field label="Pipeline">
            <select value={pick} onChange={(e) => setPick(e.target.value)} className={input}>
              {list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <p className="text-xs text-muted-foreground">
            This adds the pipeline <strong>{TEMPLATE}</strong> to your Pipelines page.
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || list === null} onClick={submit}>
            {busy ? 'Starting…' : 'Start the run'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ago(s: number) {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - s) / 60))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const h = Math.round(mins / 60)
  if (h < 24) return `${h} h ago`
  const days = Math.round(h / 24)
  return days < 30 ? `${days} d ago` : new Date(s * 1000).toLocaleDateString()
}

function DiagramCard({ d, canDraw, busy, onOpen, onBuild, onDraw, onDelete }: { d: Diagram; canDraw: boolean; busy: boolean; onOpen: () => void; onBuild: () => void; onDraw: () => void; onDelete: () => void }) {
  return (
    <div className="group/card overflow-hidden rounded-xl border border-border/60 bg-card transition-colors hover:border-border">
      <button type="button" onClick={onOpen} aria-label={`Open ${titleOf(d)}`} className="relative block aspect-[16/9] w-full overflow-hidden border-b border-border/60 bg-muted/40">
        <iframe
          title={`Preview of ${titleOf(d)}`}
          src={viewUrl(d)}
          loading="lazy"
          tabIndex={-1}
          sandbox="allow-scripts allow-same-origin"
          className="pointer-events-none absolute top-0 left-0 h-[300%] w-[300%] origin-top-left scale-[0.3334] border-0"
        />
        <span className="absolute inset-0 bg-gradient-to-t from-card/40 to-transparent opacity-0 transition-opacity group-hover/card:opacity-100" />
      </button>
      <div className="flex items-start gap-2 px-3 py-2.5">
        <button type="button" onClick={onOpen} className="grid min-w-0 flex-1 gap-0.5 text-left">
          <span className="truncate text-[13px] font-medium capitalize">{titleOf(d)}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 leading-4">
              <Server className="size-2.5" /> {d.machine}
            </span>
            <span className="truncate" title={when(d.modified)}>
              {ago(d.modified)}
            </span>
          </span>
        </button>
        <Button size="xs" variant="outline" className="opacity-0 transition-opacity group-hover/card:opacity-100 focus-visible:opacity-100" onClick={onBuild}>
          Build from this
        </Button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-label={`More for ${titleOf(d)}`} disabled={busy}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={() => later(onOpen)}>
              <Network /> Open
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => later(onBuild)}>
              <Workflow /> Build from this
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canDraw} onSelect={() => later(onDraw)}>
              <RefreshCw /> Draw again
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => later(onDelete)}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

export function DiagramsPage({
  projects,
  onOpenSession,
  onOpenPipeline
}: {
  projects: Project[]
  onOpenSession: (machine: string, name: string) => void
  onOpenPipeline: (id: string) => void
}) {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [query, setQuery] = useState('')
  const [machine, setMachine] = useState('')
  const [drawing, setDrawing] = useState<{ machine?: string; folder?: string } | null>(null)
  const [building, setBuilding] = useState<Diagram | null>(null)
  const [opened, setOpened] = useState<Diagram | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await api<Data>('GET', '/api/diagrams')
      setData(d)
      setError('')
      const q = new URLSearchParams(location.search)
      if (q.get('dir'))
        setOpened(
          (o) =>
            o ||
            d.diagrams.find((x) => x.machine === q.get('machine') && x.folder === q.get('folder') && x.dir === q.get('dir') && x.file === q.get('file')) ||
            null
        )
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    load()
    const back = () => !location.search && setOpened(null)
    window.addEventListener('popstate', back)
    return () => window.removeEventListener('popstate', back)
  }, [load])

  const act = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key)
    try {
      await work()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
      await load()
    }
  }

  const open = (d: Diagram | null) => {
    setOpened(d)
    history.pushState(
      null,
      '',
      d ? `${location.pathname}?${new URLSearchParams({ machine: d.machine, folder: d.folder, dir: d.dir, file: d.file })}` : location.pathname
    )
  }

  if (opened)
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <Button size="sm" variant="ghost" onClick={() => open(null)} className="text-muted-foreground">
            <ChevronLeft /> Diagrams
          </Button>
          <h1 className="text-[15px] font-semibold capitalize">{titleOf(opened)}</h1>
          <span className="truncate text-xs text-muted-foreground" title={opened.folder}>
            {baseName(opened.folder)} on {opened.machine}
          </span>
          <span className="flex-1" />
          <Button size="sm" variant="outline" onClick={() => setBuilding(opened)}>
            Build from this
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!(data?.machines || []).some((x) => x.name === opened.machine && x.state === 'installed')}
            onClick={() => setDrawing({ machine: opened.machine, folder: opened.folder })}
          >
            <RefreshCw /> Draw again
          </Button>
        </header>
        <iframe
          title={`Diagram: ${titleOf(opened)}`}
          sandbox="allow-scripts allow-downloads"
          src={viewUrl(opened)}
          className="min-h-0 flex-1 border-0 bg-white"
        />
        {drawing && data && (
          <DrawDialog
            projects={projects}
            data={data}
            start={drawing}
            onClose={() => setDrawing(null)}
            onStarted={(machine, name) => (setDrawing(null), onOpenSession(machine, name))}
          />
        )}
        {building && <BuildDialog d={building} onClose={() => setBuilding(null)} onStarted={(id) => (setBuilding(null), onOpenPipeline(id))} />}
      </div>
    )

  const ready = (data?.machines || []).filter((m) => m.state === 'installed')
  const q = query.trim().toLowerCase()
  const shown = (data?.diagrams || [])
    .filter((d) => (!machine || d.machine === machine) && (!q || `${titleOf(d)} ${d.folder} ${d.machine}`.toLowerCase().includes(q)))
    .sort((x, y) => y.modified - x.modified)
  const repos = [...new Set(shown.map((d) => baseName(d.folder)))]
  const needs = (data?.machines || []).filter((m) => m.state !== 'installed')
  const remove = async (d: Diagram) => {
    if (!(await confirmAction({ title: `Delete ${titleOf(d)}?`, body: `This removes its folder from .archify in ${d.folder} on ${d.machine}.`, confirm: 'Delete', danger: true }))) return
    act(`delete:${d.machine}/${d.folder}/${d.dir}`, () => api('POST', '/api/diagrams/delete', { machine: d.machine, folder: d.folder, dir: d.dir }))
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b border-border/60">
        <div className="flex min-h-12 w-full items-center gap-3 px-3 md:px-5">
          <span className="-mb-px flex h-12 items-center gap-1.5 border-b-2 border-foreground px-2 text-sm font-semibold">
            Diagrams <span className="text-xs font-normal text-muted-foreground">{data?.diagrams.length ?? ''}</span>
          </span>
          {data && <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">Archify {data.version}</span>}
          <span className="flex-1" />
          <Button size="sm" disabled={!ready.length} onClick={() => setDrawing({})}>
            <Plus /> New diagram
          </Button>
        </div>
        {data && data.diagrams.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2 md:px-5">
            <div className="relative min-w-[14rem] flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search diagrams, folders or machines…"
                aria-label="Search diagrams"
                className="h-7 w-full rounded-md border border-input bg-muted/55 pr-2 pl-7 text-xs outline-none"
              />
            </div>
            {[{ name: '' }, ...data.machines].map((m) => (
              <button
                key={m.name || 'all'}
                type="button"
                aria-pressed={machine === m.name}
                onClick={() => setMachine(m.name)}
                className={cn(
                  'inline-flex h-7 items-center rounded-full border px-2.5 text-xs transition-colors',
                  machine === m.name ? 'border-foreground/25 bg-accent text-foreground' : 'border-border text-muted-foreground hover:text-foreground'
                )}
              >
                {m.name || 'All machines'}
              </button>
            ))}
          </div>
        )}
      </header>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto">
        <div className="mx-auto grid w-full max-w-[1400px] gap-6 px-3 pt-4 pb-10 md:px-5">
          {!data &&
            (error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Asking your machines…</p>
            ))}
          {data && !data.machines.length && <p className="py-16 text-center text-sm text-muted-foreground">No machines yet. Add one in Settings, Machines.</p>}
          {needs.length > 0 && (
            <div className="grid gap-2">
              {needs.map((m) => (
                <div key={m.name} className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-[13px]">
                  <Server className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{m.name}</span>{' '}
                    <span className={cn('text-xs', m.state === 'offline' ? 'text-destructive' : 'text-muted-foreground')}>
                      {m.state === 'offline'
                        ? m.problem
                        : m.state === 'needs_node'
                          ? `needs Node 18 or later before Archify can run. Yardbell does not install it.`
                          : `doesn't have Archify ${data!.version} yet.`}
                    </span>
                  </span>
                  {m.state === 'not_installed' ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy === `install:${m.name}`}
                      onClick={() =>
                        act(`install:${m.name}`, async () => {
                          await api('POST', '/api/diagrams/install', { machine: m.name })
                          toast(`Archify ${data!.version} is installed on ${m.name}.`)
                        })
                      }
                    >
                      {busy === `install:${m.name}` ? 'Installing…' : 'Install'}
                    </Button>
                  ) : (
                    <Button size="xs" variant="ghost" onClick={load}>
                      <RefreshCw /> Check again
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          {data && data.machines.length > 0 && !data.diagrams.length && (
            <div className="grid justify-items-center gap-2 py-20 text-center">
              <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
                <Network className="size-6" />
              </span>
              <p className="text-sm font-medium">No diagrams yet</p>
              <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
                An agent reads a repository with Archify and draws an interactive map of it: its parts, how they talk and where data flows. Diagrams are saved in each folder's{' '}
                <code className="font-mono">.archify</code>, kept out of git.
              </p>
              <Button size="sm" className="mt-2" disabled={!ready.length} onClick={() => setDrawing({})}>
                <Plus /> Draw your first diagram
              </Button>
            </div>
          )}
          {data && data.diagrams.length > 0 && !shown.length && <p className="py-12 text-center text-sm text-muted-foreground">No diagrams match.</p>}
          {repos.map((repo) => (
            <section key={repo} className="grid gap-3">
              <h2 className="flex items-center gap-2 text-[13px] font-semibold">
                <Folder className="size-3.5 text-muted-foreground" /> {repo}
                <span className="text-xs font-normal text-muted-foreground">{shown.filter((d) => baseName(d.folder) === repo).length}</span>
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {shown
                  .filter((d) => baseName(d.folder) === repo)
                  .map((d) => (
                    <DiagramCard
                      key={`${d.machine}/${d.folder}/${d.dir}`}
                      d={d}
                      canDraw={ready.some((x) => x.name === d.machine)}
                      busy={busy === `delete:${d.machine}/${d.folder}/${d.dir}`}
                      onOpen={() => open(d)}
                      onBuild={() => setBuilding(d)}
                      onDraw={() => setDrawing({ machine: d.machine, folder: d.folder })}
                      onDelete={() => remove(d)}
                    />
                  ))}
              </div>
            </section>
          ))}
        </div>
      </div>
      {drawing && data && (
        <DrawDialog
          projects={projects}
          data={data}
          start={drawing}
          onClose={() => setDrawing(null)}
          onStarted={(machine, name) => (setDrawing(null), onOpenSession(machine, name))}
        />
      )}
      {building && <BuildDialog d={building} onClose={() => setBuilding(null)} onStarted={(id) => (setBuilding(null), onOpenPipeline(id))} />}
    </div>
  )
}
