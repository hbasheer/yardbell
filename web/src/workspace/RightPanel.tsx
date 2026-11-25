import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Ellipsis,
  FileDiff,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  Files as FilesIcon,
  History,
  ListChecks,
  ListCollapse,
  ListFilter,
  Loader2,
  MessageSquare,
  Minus,
  PanelRight,
  Plug,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Sparkles,
  Trash,
  Undo2,
  X,
  type LucideIcon
} from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { later, MenuItems, type MenuEntry } from '@/components/ui/menu-items'
import { confirmAction } from '@/lib/confirm'
import { ChecksTab, HistoryTab, PanelEmpty, PortsTab } from './SidePanels'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { copy } from '@/lib/actions'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { notesIn, useNotes } from '@/lib/notes'
import { getJson, type YardbellState } from '@/lib/state'
import { SendNotes, type Place } from './SendNotes'

type Entry = { name: string; kind: 'dir' | 'file'; size: number }
type Change = {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
  added?: number
  removed?: number
  binary?: boolean
  old_path?: string
}
type Changes = { branch?: string; upstream?: string; ahead?: number; behind?: number; files: Change[]; truncated?: boolean }

const LETTER: Record<string, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' }
const STATUS_COLOR: Record<string, string> = {
  modified: 'var(--git-decoration-modified)',
  added: 'var(--git-decoration-added)',
  deleted: 'var(--git-decoration-deleted)',
  renamed: 'var(--git-decoration-renamed)',
  untracked: 'var(--git-decoration-untracked)'
}
const ACTION_DONE: Record<string, string> = { push: 'Pushed', pull: 'Pulled', fetch: 'Fetched' }
const DOTFILES = 'yardbell.explorer.dotfiles'
const POLL = 5000
const base = (p: string) => p.split('/').pop() || p
const dirOf = (p: string) => p.split('/').slice(0, -1).join('/')
const api = (m: string) => `/machines/${encodeURIComponent(m)}`


function RowMenu({ items, children }: { items: MenuEntry[]; children: React.ReactElement }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <MenuItems as="context" items={items} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

const copyItems = (place: Place, path: string): MenuEntry[] => [
  { label: 'Copy path', icon: Copy, onSelect: () => copy(`${place.path.replace(/\/$/, '')}/${path}`, 'the path') },
  { label: 'Copy relative path', icon: Copy, onSelect: () => copy(path, 'the relative path') }
]

const ghostIcon = 'text-muted-foreground hover:text-foreground'

function FilesTab({
  place,
  onOpenFile,
  findSignal,
  statuses
}: {
  place: Place
  onOpenFile: (path: string) => void
  findSignal: number
  statuses: Map<string, Change['status']>
}) {
  const findBox = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (findSignal) findBox.current?.focus()
  }, [findSignal])
  const [dirs, setDirs] = useState<Map<string, { entries?: Entry[]; error?: string; more?: boolean }>>(new Map())
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [find, setFind] = useState('')
  const [mode, setMode] = useState<'names' | 'contents'>('names')
  const [found, setFound] = useState<{ matches: string[]; more: boolean } | null>(null)
  const [searching, setSearching] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [dotfiles, setDotfiles] = useState(() => localStorage.getItem(DOTFILES) !== '0')
  const [selected, setSelected] = useState('')

  const loadDir = useCallback(
    (path: string) =>
      getJson<{ entries: Entry[]; more: boolean }>(`${api(place.machine)}/files?${new URLSearchParams({ root: place.path, path })}`)
        .then((d) => setDirs((m) => new Map(m).set(path, d)))
        .catch((e) => setDirs((m) => new Map(m).set(path, { error: e.message }))),
    [place]
  )

  useEffect(() => {
    setDirs(new Map())
    setOpen(new Set())
    loadDir('')
  }, [loadDir])

  useEffect(() => {
    if (!find.trim()) {
      setFound(null)
      return
    }
    setSearching(true)
    const t = setTimeout(
      () => {
        getJson<{ matches: string[]; more: boolean }>(`${api(place.machine)}/files/search?${new URLSearchParams({ root: place.path, q: find.trim(), mode })}`)
          .then(setFound)
          .catch((e) => toast.error(e.message))
          .finally(() => setSearching(false))
      },
      mode === 'contents' ? 400 : 200
    )
    return () => clearTimeout(t)
  }, [find, mode, place])

  const refresh = async () => {
    setRefreshing(true)
    await Promise.all([loadDir(''), ...[...open].map(loadDir)])
    setRefreshing(false)
  }

  const toggle = (path: string) => {
    const next = new Set(open)
    if (next.has(path)) next.delete(path)
    else {
      next.add(path)
      if (!dirs.get(path)?.entries) loadDir(path)
    }
    setOpen(next)
  }

  const dirStatus = (rel: string) => {
    for (const [p, st] of statuses) if (p.startsWith(`${rel}/`)) return st === 'deleted' ? 'modified' : st
    return undefined
  }

  const fileRow = 'flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-xs transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

  const rows = (path: string, depth: number): React.ReactNode => {
    const d = dirs.get(path)
    const pad = { paddingLeft: depth * 16 + 8 }
    if (!d)
      return (
        <div className="flex items-center gap-1 py-1 text-xs text-muted-foreground" style={pad}>
          <span className="size-3 shrink-0" />
          <Loader2 className="size-3 animate-spin" /> Loading…
        </div>
      )
    if (d.error)
      return (
        <div role="alert" className="flex items-center gap-1 py-1 text-xs text-destructive" style={pad}>
          <span className="size-3 shrink-0" />
          <CircleAlert className="size-3 shrink-0" />
          <span className="truncate">{d.error}</span>
        </div>
      )
    return d.entries!
      .filter((e) => e.name !== '.git' && (dotfiles || !e.name.startsWith('.')))
      .map((e) => {
        const rel = path ? `${path}/${e.name}` : e.name
        if (e.kind === 'dir') {
          const st = dirStatus(rel)
          return (
            <div key={rel}>
              <button type="button" onClick={() => toggle(rel)} className={cn(fileRow, 'hover:bg-accent hover:text-foreground')} style={pad} aria-expanded={open.has(rel)}>
                <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open.has(rel) && 'rotate-90')} />
                {open.has(rel) ? <FolderOpen className="size-3 shrink-0 text-muted-foreground" /> : <Folder className="size-3 shrink-0 text-muted-foreground" />}
                <span className="truncate" style={st ? { color: STATUS_COLOR[st] } : undefined}>
                  {e.name}
                </span>
                {st && <span className="mr-2 ml-auto size-1.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[st] }} />}
              </button>
              {open.has(rel) && rows(rel, depth + 1)}
            </div>
          )
        }
        const st = statuses.get(rel)
        return (
          <RowMenu key={rel} items={[{ label: 'Open', icon: FileText, onSelect: () => onOpenFile(rel) }, 'separator', ...copyItems(place, rel)]}>
            <button
              type="button"
              data-selected={selected === rel || undefined}
              onClick={() => {
                setSelected(rel)
                onOpenFile(rel)
              }}
              className={cn(fileRow, selected === rel ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-foreground')}
              style={pad}
            >
              <span className="size-3 shrink-0" />
              <FileText className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate" style={st ? { color: STATUS_COLOR[st] } : undefined}>
                {e.name}
              </span>
              {st && (
                <span className="mr-2 ml-auto shrink-0 text-[10px] font-semibold tracking-wide" style={{ color: STATUS_COLOR[st] }}>
                  {LETTER[st]}
                </span>
              )}
            </button>
          </RowMenu>
        )
      })
  }

  const toggleDotfiles = (on: boolean) => {
    setDotfiles(on)
    try {
      localStorage.setItem(DOTFILES, on ? '1' : '0')
    } catch {}
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 min-h-8 items-center gap-2 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={place.path}>
          {base(place.path)}
        </span>
        <Hint label="Collapse All" side="bottom">
          <Button variant="ghost" size="icon-xs" aria-label="Collapse All" disabled={!open.size} onClick={() => setOpen(new Set())} className={ghostIcon}>
            <ListCollapse className="size-3" />
          </Button>
        </Hint>
        <Hint label="Refresh Explorer" side="bottom">
          <Button variant="ghost" size="icon-xs" aria-label="Refresh Explorer" disabled={refreshing} onClick={refresh} className={ghostIcon}>
            {refreshing ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          </Button>
        </Hint>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="More Explorer Actions" title="More Explorer Actions" className={ghostIcon}>
              <Ellipsis className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[12rem]">
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault()
                toggleDotfiles(!dotfiles)
              }}
            >
              <Check className={cn('size-3.5', !dotfiles && 'invisible')} /> Show Dotfiles
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => copy(place.path, 'the path')}>
              <Copy className="size-3.5" /> Copy Path
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="border-b border-border px-2 py-2">
        <div className="flex flex-col gap-2">
          <div className="rounded-md bg-muted p-0.5">
            <div role="radiogroup" aria-label="Explorer search mode" className="flex h-6 w-full gap-px">
              {(['names', 'contents'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  aria-label={m === 'names' ? 'Filter files by name' : 'Search file contents'}
                  onClick={() => {
                    setMode(m)
                    findBox.current?.focus()
                  }}
                  className={cn(
                    'min-w-0 flex-1 rounded-[5px] text-xs font-medium transition-colors',
                    mode === m ? 'bg-background text-foreground shadow-xs dark:bg-input/60' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {m === 'names' ? 'Names' : 'Contents'}
                </button>
              ))}
            </div>
          </div>
          <label className="flex h-8 items-center gap-1 rounded-md border border-border bg-input/50 px-2 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
            {mode === 'names' ? <ListFilter className="size-3.5 shrink-0 text-muted-foreground" /> : <Search className="size-3.5 shrink-0 text-muted-foreground" />}
            <input
              ref={findBox}
              value={find}
              onChange={(e) => setFind(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setFind('')}
              placeholder={mode === 'contents' ? 'Search' : 'Filter files'}
              className="min-w-0 flex-1 bg-transparent py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
            {searching && <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />}
            {find && (
              <button type="button" aria-label="Clear" onClick={() => setFind('')} className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground">
                <X className="size-3" />
              </button>
            )}
          </label>
        </div>
      </div>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-1 py-1 pb-4">
        {found ? (
          found.matches.length ? (
            found.matches.map((p) => (
              <button key={p} type="button" onClick={() => onOpenFile(p)} className={cn(fileRow, 'hover:bg-accent')}>
                <FileText className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate" style={statuses.get(p) ? { color: STATUS_COLOR[statuses.get(p)!] } : undefined}>
                  {base(p)}
                </span>
                <span className="min-w-0 truncate text-[11px] text-muted-foreground">{dirOf(p)}</span>
              </button>
            ))
          ) : (
            <p className="px-2 py-1 text-xs text-muted-foreground">{mode === 'contents' ? 'No file contains that.' : 'No file has that name.'}</p>
          )
        ) : (
          rows('', 0)
        )}
      </div>
    </div>
  )
}

function SectionHeader({
  label,
  count,
  folded,
  onToggle,
  children
}: {
  label: string
  count: number
  folded: boolean
  onToggle: () => void
  children?: React.ReactNode
}) {
  return (
    <div className="pt-3 pr-3 pb-1 pl-1">
      <div className="group/section flex items-center gap-x-1 rounded-md pr-1 hover:bg-accent hover:text-accent-foreground">
        <button type="button" onClick={onToggle} aria-expanded={!folded} className="flex min-w-0 flex-1 items-center gap-1 py-0.5 pl-1 text-left">
          <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', folded && '-rotate-90')} />
          <span className="flex min-w-0 flex-1 items-center gap-1 text-xs font-semibold tracking-wider text-foreground/70 uppercase group-hover/section:text-accent-foreground">
            <span className="min-w-0 truncate">{label}</span>
            <span className="shrink-0 text-[11px] font-medium tabular-nums">{count}</span>
          </span>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/section:opacity-100 focus-within:opacity-100">{children}</div>
      </div>
    </div>
  )
}

function RowAction({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <Hint label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
      >
        <Icon className="size-3.5" />
      </button>
    </Hint>
  )
}

function ChangesTab({
  place,
  list,
  reload,
  onOpenDiff,
  onOpenFile,
  state
}: {
  place: Place
  list: Changes | { error: string } | null
  reload: () => void
  onOpenDiff: (path: string, staged: boolean) => void
  onOpenFile: (path: string) => void
  state: YardbellState | null
}) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState('')
  const [sending, setSending] = useState(false)
  const [filtering, setFiltering] = useState(false)
  const [filter, setFilter] = useState('')
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const store = useNotes()
  const waiting = notesIn(store, place.machine, place.path)

  useEffect(() => setMessage(''), [place])

  if (!list) return <p className="p-3 text-xs text-muted-foreground">Reading the changes…</p>
  if ('error' in list)
    return (
      <p role="alert" className="p-3 text-xs text-destructive">
        {list.error}
      </p>
    )

  const words = filter.toLowerCase()
  const shown = list.files.filter((f) => !words || f.path.toLowerCase().includes(words))
  const staged = shown.filter((f) => f.staged)
  const unstaged = shown.filter((f) => !f.staged)
  const anyStaged = list.files.some((f) => f.staged)
  const uniq = (files: Change[]) => [...new Set(files.map((f) => f.path))]

  const run = async (action: string, paths: string[] = [], quiet = false) => {
    setBusy(action)
    try {
      const res = await fetch(`${api(place.machine)}/changes/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ root: place.path, paths })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Yardbell answered ${res.status}`)
      if (!quiet && !paths.length) toast(ACTION_DONE[action] || 'Done')
      return true
    } catch (e) {
      toast.error((e as Error).message)
      return false
    } finally {
      setBusy('')
      reload()
    }
  }

  const discard = async (files: Change[]) => {
    const untracked = files.some((f) => f.status === 'untracked')
    const ok = await confirmAction({
      title: files.length === 1 ? `Discard changes in ${base(files[0].path)}?` : `Discard changes in ${uniq(files).length} files?`,
      body: untracked ? 'Untracked files are deleted. This cannot be undone.' : 'The files go back to their last committed state. This cannot be undone.',
      confirm: untracked && files.every((f) => f.status === 'untracked') ? 'Delete' : 'Discard',
      danger: true
    })
    if (ok) run('discard', uniq(files))
  }

  const draft = async () => {
    try {
      const d = await getJson<{ message: string; from?: string }>(`${api(place.machine)}/changes/draft?${new URLSearchParams({ root: place.path })}`)
      setMessage(d.message || '')
      if (d.from === 'files') toast('Drafted from the file names. Edit it before you commit.')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const commit = async (then?: 'push') => {
    if (!message.trim()) return toast.error('Write a commit message first')
    setBusy('commit')
    try {
      const body: Record<string, unknown> = { root: place.path, message }
      if (anyStaged) body.staged = true
      else if (!list.truncated) body.paths = uniq(list.files)
      const res = await fetch(`${api(place.machine)}/changes/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body)
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Yardbell answered ${res.status}`)
      setMessage('')
      toast(`Committed ${data.short}`)
      if (then === 'push') await run('push')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
      reload()
    }
  }

  const ahead = list.ahead || 0
  const behind = list.behind || 0
  const dirty = list.files.length > 0
  const primary = dirty
    ? { label: anyStaged ? 'Commit' : 'Commit All', icon: Check, run: () => commit(), disabled: !message.trim() }
    : behind
      ? { label: `Pull ${behind}`, icon: ArrowDown, run: () => run('pull'), disabled: false }
      : ahead
        ? { label: `Push ${ahead}`, icon: ArrowUp, run: () => run('push'), disabled: false }
        : { label: 'Fetch', icon: RefreshCw, run: () => run('fetch'), disabled: false }

  const fileRow = (f: Change) => (
    <RowMenu
      key={`${f.path}${f.staged}`}
      items={[
        { label: 'Open Changes', icon: FileDiff, onSelect: () => onOpenDiff(f.path, f.staged) },
        f.status !== 'deleted' && { label: 'Open File', icon: FileText, onSelect: () => onOpenFile(f.path) },
        'separator',
        f.staged ? { label: 'Unstage', icon: Minus, onSelect: () => run('unstage', [f.path]) } : { label: 'Stage', icon: Plus, onSelect: () => run('stage', [f.path]) },
        !f.staged && { label: f.status === 'untracked' ? 'Delete File' : 'Discard Changes', icon: f.status === 'untracked' ? Trash : Undo2, danger: true, onSelect: () => discard([f]) },
        'separator',
        ...copyItems(place, f.path)
      ]}
    >
      <div
        role="button"
        tabIndex={0}
        title={f.path}
        onClick={() => onOpenDiff(f.path, f.staged)}
        onKeyDown={(e) => e.key === 'Enter' && onOpenDiff(f.path, f.staged)}
        className="group relative flex cursor-pointer items-center gap-1 py-1 pr-3 pl-2 transition-colors outline-none hover:bg-accent focus-visible:bg-accent"
      >
        <FileText className="size-3.5 shrink-0" style={{ color: STATUS_COLOR[f.status] }} />
        <div className="min-w-0 flex-1 text-xs">
          <span className="block min-w-0 truncate">
            <span className="text-foreground">{base(f.path)}</span>
            {dirOf(f.path) && <span className="ml-1.5 text-[11px] text-muted-foreground">{dirOf(f.path)}</span>}
          </span>
        </div>
        {f.binary ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">binary</span>
        ) : (
          <span className="shrink-0 text-[10px] tabular-nums">
            {Boolean(f.added) && <span className="text-[var(--git-decoration-added)]">+{f.added}</span>}
            {Boolean(f.removed) && <span className="ml-1 text-[var(--git-decoration-deleted)]">-{f.removed}</span>}
          </span>
        )}
        <span className="w-4 shrink-0 text-center text-[10px] font-bold" style={{ color: STATUS_COLOR[f.status] }}>
          {LETTER[f.status] || '?'}
        </span>
        <div className="pointer-events-none absolute top-0 right-0 bottom-0 flex shrink-0 items-center gap-1.5 bg-accent pr-3 pl-2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
          {f.status !== 'deleted' && <RowAction icon={FileText} label="Open File" onClick={() => onOpenFile(f.path)} />}
          {!f.staged && <RowAction icon={f.status === 'untracked' ? Trash : Undo2} label={f.status === 'untracked' ? 'Delete untracked file' : 'Discard Changes'} onClick={() => discard([f])} />}
          {f.staged ? <RowAction icon={Minus} label="Unstage Changes" onClick={() => run('unstage', [f.path])} /> : <RowAction icon={Plus} label="Stage Changes" onClick={() => run('stage', [f.path])} />}
        </div>
      </div>
    </RowMenu>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-3 pt-1.5 pb-1">
        {filtering ? (
          <div className="flex w-full min-w-0 items-center gap-1.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                setFilter('')
                setFiltering(false)
              }}
              placeholder="Filter files…"
              aria-label="Filter files…"
              className="w-full min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Close filter"
              onClick={() => {
                setFilter('')
                setFiltering(false)
              }}
              className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-1">
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-muted-foreground">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate font-medium text-foreground">{list.branch || 'no branch'}</span>
              {list.upstream && <span className="truncate">→ {list.upstream}</span>}
              {(ahead > 0 || behind > 0) && (
                <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
                  {ahead > 0 && (
                    <span className="inline-flex items-center">
                      <ArrowUp className="size-3" />
                      {ahead}
                    </span>
                  )}
                  {behind > 0 && (
                    <span className="inline-flex items-center">
                      <ArrowDown className="size-3" />
                      {behind}
                    </span>
                  )}
                </span>
              )}
            </span>
            <Hint label="Filter files by name" side="bottom">
              <Button variant="ghost" size="icon-xs" aria-label="Filter files by name" onClick={() => setFiltering(true)} className={ghostIcon}>
                <Search className="size-3.5" />
              </Button>
            </Hint>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="More Source Control Actions" title="More Source Control Actions" className={ghostIcon}>
                  <Ellipsis className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={() => run('fetch')}>
                  <RefreshCw className="size-3.5" /> Fetch
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => run('pull')}>
                  <ArrowDown className="size-3.5" /> Pull
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => run('push')}>
                  <ArrowUp className="size-3.5" /> Push
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={reload}>
                  <RotateCw className="size-3.5" /> Refresh
                </DropdownMenuItem>
                {waiting.length > 0 && (
                  <DropdownMenuItem onSelect={() => later(() => setSending(true))}>
                    <MessageSquare className="size-3.5" /> Send review notes ({waiting.length})
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
        <div className="px-3 pt-2 pb-2">
          {dirty && (
            <div className="relative">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && commit()}
                placeholder="Message"
                aria-label="Commit message"
                className="mt-0.5 min-h-14 w-full resize-none appearance-none rounded-md border border-input bg-background px-2 py-1.5 pr-8 text-xs text-foreground shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
              />
              <Hint label="Draft a message from the changes" side="bottom">
                <button
                  type="button"
                  aria-label="Draft a message from the changes"
                  onClick={draft}
                  className="absolute top-1.5 right-1.5 inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Sparkles className="size-3.5" />
                </button>
              </Hint>
            </div>
          )}
          <div className={cn('flex min-w-0 items-stretch gap-1', dirty && 'mt-1')}>
            <div className="flex min-w-0 flex-1 items-stretch">
              <Button size="sm" onClick={primary.run} disabled={primary.disabled || Boolean(busy)} className="h-7 min-w-0 flex-1 shrink rounded-r-none px-3 text-[11px]">
                {busy && busy !== 'stage' && busy !== 'unstage' && busy !== 'discard' ? <Loader2 className="size-3.5 animate-spin" /> : <primary.icon className="size-3.5" />}
                <span className="truncate">{primary.label}</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" disabled={Boolean(busy)} aria-label="More commit and remote actions" className="h-7 rounded-l-none border-l border-primary-foreground/20 px-1.5">
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-58">
                  <DropdownMenuItem disabled={!dirty || !message.trim()} onSelect={() => commit()}>
                    <Check className="size-3.5" /> Commit
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!dirty || !message.trim()} onSelect={() => commit('push')}>
                    <ArrowUp className="size-3.5" /> Commit &amp; Push
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => run('push')}>
                    <ArrowUp className="size-3.5" /> Push{ahead ? ` ${ahead}` : ''}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => run('pull')}>
                    <ArrowDown className="size-3.5" /> Pull{behind ? ` ${behind}` : ''}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => run('fetch')}>
                    <RefreshCw className="size-3.5" /> Fetch
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>

        {!list.files.length && <p className="px-4 py-2 text-xs text-muted-foreground">No changes. The working tree matches the last commit.</p>}
        {list.files.length > 0 && !shown.length && <p className="px-4 py-2 text-xs text-muted-foreground">No changed file matches the filter.</p>}

        {staged.length > 0 && (
          <section>
            <SectionHeader label="Staged Changes" count={staged.length} folded={Boolean(folded.staged)} onToggle={() => setFolded((f) => ({ ...f, staged: !f.staged }))}>
              <RowAction icon={Minus} label="Unstage All Changes" onClick={() => run('unstage', uniq(staged))} />
            </SectionHeader>
            {!folded.staged && staged.map(fileRow)}
          </section>
        )}
        {unstaged.length > 0 && (
          <section>
            <SectionHeader label="Changes" count={unstaged.length} folded={Boolean(folded.changes)} onToggle={() => setFolded((f) => ({ ...f, changes: !f.changes }))}>
              <RowAction icon={Undo2} label="Discard All Changes" onClick={() => discard(unstaged)} />
              <RowAction icon={Plus} label="Stage All Changes" onClick={() => run('stage', uniq(unstaged))} />
            </SectionHeader>
            {!folded.changes && unstaged.map(fileRow)}
          </section>
        )}
        {list.truncated && <p className="px-4 py-2 text-[11px] text-muted-foreground">Too many changes to list them all here.</p>}
      </div>
      <SendNotes open={sending} onOpenChange={setSending} place={place} list={waiting} state={state} />
    </div>
  )
}

export type PanelTab = 'files' | 'agents' | 'changes' | 'checks' | 'ports'

const TAB_LABEL: Record<PanelTab, string> = { files: 'Explorer', agents: 'Agents', changes: 'Source Control', checks: 'Checks', ports: 'Ports' }

export function RightPanel({
  place,
  state,
  tab,
  onTab,
  onOpenFile,
  onOpenDiff,
  onResumed,
  onClose,
  findSignal
}: {
  place: Place | null
  state: YardbellState | null
  tab: PanelTab
  onTab: (t: PanelTab) => void
  findSignal: number
  onOpenFile: (path: string) => void
  onOpenDiff: (path: string, staged: boolean) => void
  onResumed: (key: string) => void
  onClose: () => void
}) {
  const [changes, setChanges] = useState<Changes | { error: string } | null>(null)
  const placeKey = place ? `${place.machine}\n${place.path}` : ''

  const machine = place?.machine
  const root = place?.path
  const reload = useCallback(() => {
    if (!machine || !root) return
    getJson<Changes>(`${api(machine)}/changes?${new URLSearchParams({ root })}`)
      .then(setChanges)
      .catch((e) => setChanges({ error: e.message }))
  }, [machine, root])

  useEffect(() => {
    setChanges(null)
    reload()
    const t = setInterval(() => !document.hidden && reload(), POLL)
    return () => clearInterval(t)
  }, [reload])

  const count = changes && !('error' in changes) ? new Set(changes.files.map((f) => f.path)).size : 0
  const statuses = new Map<string, Change['status']>()
  if (changes && !('error' in changes)) for (const f of changes.files) if (!statuses.has(f.path) || !f.staged) statuses.set(f.path, f.status)
  const tabs: { id: PanelTab; icon: LucideIcon; count?: number }[] = [
    { id: 'files', icon: FilesIcon },
    { id: 'agents', icon: History },
    { id: 'changes', icon: GitBranch, count },
    { id: 'checks', icon: ListChecks },
    { id: 'ports', icon: Plug }
  ]

  return (
    <aside className="flex min-h-0 w-full flex-col border-l border-border bg-card">
      <div className="flex h-8 shrink-0 items-stretch border-b border-border bg-tab-bar pl-1">
        <div className="flex min-w-0 flex-1 items-stretch gap-0.5">
          {tabs.map((t) => (
            <Hint key={t.id} label={TAB_LABEL[t.id]}>
              <button
                type="button"
                onClick={() => onTab(t.id)}
                aria-label={t.count ? `${TAB_LABEL[t.id]}, ${t.count} changed` : TAB_LABEL[t.id]}
                aria-pressed={tab === t.id}
                className={cn('relative grid w-8 place-items-center text-muted-foreground hover:text-foreground', tab === t.id && 'text-foreground')}
              >
                <t.icon size={15} />
                {Boolean(t.count) && (
                  <span className="absolute top-0.5 right-0 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-foreground px-1 text-3xs leading-none font-semibold text-background tabular-nums">
                    {t.count! > 99 ? '99+' : t.count}
                  </span>
                )}
                {tab === t.id && <span className="absolute right-[25%] bottom-0 left-[25%] h-[2px] rounded-t bg-activity-bar-indicator" />}
              </button>
            </Hint>
          ))}
        </div>
        <Hint label="Hide the right sidebar">
          <button
            type="button"
            aria-label="Hide the right sidebar"
            onClick={onClose}
            className="mx-1 my-auto grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          >
            <PanelRight className="size-4" />
          </button>
        </Hint>
      </div>
      {!place ? (
        <PanelEmpty icon={FolderOpen} title="No folder picked">
          Open a session or pick a worktree in the sidebar to see its files, changes, checks and ports here.
        </PanelEmpty>
      ) : tab === 'files' ? (
        <FilesTab key={placeKey} place={place} onOpenFile={onOpenFile} findSignal={findSignal} statuses={statuses} />
      ) : tab === 'agents' ? (
        <HistoryTab place={place} onResumed={onResumed} />
      ) : tab === 'checks' ? (
        <ChecksTab place={place} state={state} />
      ) : tab === 'ports' ? (
        <PortsTab place={place} state={state} />
      ) : (
        <ChangesTab place={place} list={changes} reload={reload} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} state={state} />
      )}
    </aside>
  )
}
