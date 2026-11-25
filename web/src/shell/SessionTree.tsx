import { useSyncExternalStore } from 'react'
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  Copy,
  ExternalLink,
  Folder,
  FolderGit2,
  GitBranch,
  House,
  LoaderCircle,
  MoreHorizontal,
  PanelsTopLeft,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ServerOff,
  Square,
  SquareTerminal,
  TriangleAlert,
  X
} from 'lucide-react'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { MenuItems, type MenuEntry } from '@/components/ui/menu-items'
import { checkNow, copy, removeProject, renameProject, stopSession } from '@/lib/actions'
import { askText, confirmAction } from '@/lib/confirm'
import { cn } from '@/lib/class-names'
import type { Session, YardbellState } from '@/lib/state'
import { agentName, buildTree, keyOf, statusOf, tail, WORD, type Line, type MachineNode, type ProjectNode, type Status } from '@/lib/tree'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Hint } from '@/components/ui/tooltip'
import { DEFAULT_OPTIONS, setTreeOptions, shapeTree, STATUS_GROUPS, useTreeOptions } from './tree-options'

export type TreeActions = {
  selected: string | null
  onSession: (key: string) => void
  onFolder: (machine: string, folder: string, path: string) => void
  onNewSession: (machine: string, path: string) => void
  onShell: (machine: string) => void
  onDashboard: (machine: string) => void
  onClose: (key: string) => void
}

function WithMenu({ items, children }: { items: MenuEntry[]; children: React.ReactElement }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <MenuItems as="context" items={items} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

const stopItem = (s: Session): MenuEntry => ({
  label: 'Stop session',
  icon: Square,
  danger: true,
  onSelect: async () => {
    if (
      await confirmAction({
        title: 'Stop this session?',
        body: 'The agent and its terminal stop. The worktree and branch stay.',
        confirm: 'Stop',
        danger: true
      })
    )
      stopSession(s)
  }
})

const FOLDED = 'yardbell.tree.folded'
const OPEN = 'yardbell.tree.open'
const AGENTS_FOLDED = 'yardbell.tree.agentsFolded'

function stored(key: string): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}') || {}
  } catch {
    return {}
  }
}

// One store per key, so a fold-all from the sidebar header reaches every project at once.
const flagStores = new Map<string, { flags: Record<string, boolean>; listeners: Set<() => void> }>()

function flagStore(key: string) {
  if (!flagStores.has(key)) flagStores.set(key, { flags: stored(key), listeners: new Set() })
  return flagStores.get(key)!
}

function writeFlags(key: string, flags: Record<string, boolean>) {
  const store = flagStore(key)
  store.flags = flags
  try {
    localStorage.setItem(key, JSON.stringify(flags))
  } catch {}
  store.listeners.forEach((l) => l())
}

function useFlags(key: string): [Record<string, boolean>, (id: string, on: boolean) => void] {
  const store = flagStore(key)
  const flags = useSyncExternalStore(
    (l) => {
      store.listeners.add(l)
      return () => store.listeners.delete(l)
    },
    () => store.flags
  )
  return [flags, (id, on) => writeFlags(key, { ...store.flags, [id]: on })]
}

export function foldAllProjects(state: YardbellState | null, open: boolean) {
  if (!state) return
  const ids = buildTree(state).flatMap((m) => m.projects.map((p) => p.id))
  writeFlags(OPEN, { ...flagStore(OPEN).flags, ...Object.fromEntries(ids.map((id) => [id, open])) })
}

export function useAnyProjectOpen(state: YardbellState | null) {
  const [open] = useFlags(OPEN)
  if (!state) return false
  return buildTree(state).some((m) => m.projects.some((p) => open[p.id] ?? p.live.length > 0))
}

function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cn('size-3.5 shrink-0 fill-none stroke-[#d97757] stroke-[1.5] [stroke-linecap:round]', className)} aria-hidden>
      <path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2M5.5 2.1l5 11.8M10.5 2.1l-5 11.8M2.1 5.5l11.8 5M13.9 5.5l-11.8 5" />
    </svg>
  )
}

function PromptMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0 fill-none stroke-muted-foreground stroke-[1.4] [stroke-linecap:round] [stroke-linejoin:round]"
      aria-hidden
    >
      <path d="M3 4.5 6.5 8 3 11.5M8 11.5h5" />
    </svg>
  )
}

export const AgentMark = ({ agent }: { agent: string }) => (/claude/i.test(agent) ? <ClaudeMark /> : <PromptMark />)

export function StatusIcon({ status, className }: { status: Status; className?: string }) {
  const cls = cn('size-3.5 shrink-0', className)
  if (status === 'working') return <LoaderCircle className={cn(cls, 'animate-spin text-agent-working')} aria-label="working" />
  if (status === 'blocked') return <CircleAlert className={cn(cls, 'text-agent-question')} aria-label="needs you" />
  if (status === 'error') return <CircleX className={cn(cls, 'text-destructive')} aria-label="stopped" />
  if (status === 'idle' || status === 'done') return <CircleCheck className={cn(cls, 'text-status-success')} aria-label={status} />
  return <span className={cn(cls, 'rounded-full border border-muted-foreground/40')} aria-label="last known" />
}

function CardDot({ status }: { status: Status }) {
  if (status === 'working') return <span className="size-2.5 shrink-0 animate-spin rounded-full border-2 border-agent-working border-r-transparent" />
  const color = status === 'blocked' ? 'bg-agent-question' : status === 'error' ? 'bg-destructive' : status ? 'bg-status-success' : 'bg-muted-foreground/40'
  return <span className={cn('size-2 shrink-0 rounded-full', color)} />
}

// The agent state dot Orca draws at the start of each agent row, at its small size.
function StateDot({ status }: { status: Status }) {
  const label = status ? WORD[status] : 'last known'
  if (status === 'working')
    return <span role="img" aria-label={label} className="size-2 shrink-0 animate-spin rounded-full border-[1.5px] border-agent-working border-r-transparent" />
  const color =
    status === 'blocked' ? 'bg-agent-question' : status === 'error' ? 'bg-destructive' : status ? 'bg-status-success' : 'border border-muted-foreground/50'
  return <span role="img" aria-label={label} className={cn('size-1.5 shrink-0 rounded-full', color)} />
}

function HostBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex h-4 max-w-[7rem] shrink-0 items-center rounded border border-border bg-accent px-1.5 text-[10px] leading-3.5 text-muted-foreground dark:border-border/50 dark:bg-[color-mix(in_oklab,var(--accent)_80%,transparent)]">
      <span className="truncate">{label}</span>
    </span>
  )
}

function AgentRow({ s, agents, actions, where }: { s: Session; agents: YardbellState['agents']; actions: TreeActions; where?: string }) {
  const key = keyOf(s)
  const status = statusOf(s)
  const current = actions.selected === key
  const items: MenuEntry[] = [
    { label: 'Open', icon: SquareTerminal, onSelect: () => actions.onSession(key) },
    { label: 'Close…', icon: X, onSelect: () => actions.onClose(key) },
    'separator',
    { label: 'Copy session name', icon: Copy, onSelect: () => copy(s.tmux || '', 'the session name') },
    (s.path || s.cwd) && { label: 'Copy path', icon: Copy, onSelect: () => copy(s.path || s.cwd || '', 'the path') },
    'separator',
    !s.stale && stopItem(s)
  ]
  const trail = where || (s.stale ? 'last known' : WORD[status] || 'idle')
  return (
    <WithMenu items={items}>
      <div className="group/agent relative">
        <button
          type="button"
          disabled={s.stale}
          draggable={!s.stale}
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-yardbell-session', key)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onClick={() => actions.onSession(key)}
          className={cn(
            'flex h-6 w-full min-w-0 items-center gap-1 rounded-sm px-1 text-left text-[11px] leading-none text-muted-foreground outline-none group-hover/agent:pr-6',
            current ? 'bg-worktree-sidebar-accent' : 'hover:bg-worktree-sidebar-accent/55 dark:hover:bg-worktree-sidebar-foreground/[0.035]',
            s.stale && 'cursor-default opacity-60',
            'focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring'
          )}
        >
          <StateDot status={status} />
          <span className="inline-flex shrink-0" title={s.agent}>
            <AgentMark agent={s.agent} />
          </span>
          <span className="min-w-0 flex-1 truncate">
            <span className={cn(status === 'blocked' ? 'font-semibold text-foreground' : 'text-muted-foreground/90', current && 'text-foreground')}>
              {agentName(s, agents)}
            </span>
            <span className={cn(current ? 'text-foreground/70' : 'text-muted-foreground/65', status === 'blocked' && 'text-agent-question-text')}>
              {' '}
              - {trail}
            </span>
          </span>
        </button>
        <button
          type="button"
          aria-label={`Close ${agentName(s, agents)}`}
          title="Close"
          onClick={(e) => {
            e.stopPropagation()
            actions.onClose(key)
          }}
          className="absolute top-1/2 right-0.5 grid size-5 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground opacity-0 group-hover/agent:opacity-100 hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100"
        >
          <X className="size-3" />
        </button>
      </div>
    </WithMenu>
  )
}

// Orca's agent summary: a pill of state dots and agent marks while folded, a plain "N agents" header while open.
function AgentsSummary({ sessions, open, onToggle }: { sessions: Session[]; open: boolean; onToggle: () => void }) {
  const groups = new Map<Status, Session[]>()
  for (const s of sessions) groups.set(statusOf(s), [...(groups.get(statusOf(s)) || []), s])
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? `Collapse ${sessions.length} agents` : `Expand ${sessions.length} agents`}
      className={cn(
        'ms-0.5 flex h-6 w-[calc(100%-0.125rem)] min-w-0 items-center gap-1 rounded-sm px-1 text-left text-[11px] leading-none text-muted-foreground',
        'hover:bg-worktree-sidebar-accent/55 focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring focus-visible:outline-none dark:hover:bg-worktree-sidebar-foreground/[0.035]',
        !open && 'translate-y-0.5 border border-worktree-sidebar-border/70 bg-worktree-sidebar-accent/35'
      )}
    >
      {open ? (
        <span className="min-w-0 flex-1 truncate px-1 font-medium text-muted-foreground">{sessions.length} agents</span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden" aria-hidden>
          {[...groups.entries()].map(([status, list]) => (
            <span key={status || 'unknown'} className="inline-flex min-w-0 shrink-0 items-center gap-0.5 rounded-sm bg-worktree-sidebar/70 px-1 py-0.5">
              <StateDot status={status} />
              <span className="flex -space-x-1">
                {list.slice(0, 3).map((s) => (
                  <AgentMark key={s.id} agent={s.agent} />
                ))}
              </span>
              {list.length > 3 && <span className="shrink-0 text-[10px] text-muted-foreground/70 tabular-nums">+{list.length - 3}</span>}
            </span>
          ))}
        </span>
      )}
      <ChevronDown className={cn('size-3 shrink-0 transition-transform duration-150', !open && '-rotate-90')} aria-hidden />
    </button>
  )
}

function WorktreeCard({
  line,
  home,
  agents,
  actions,
  showHost,
  compact = false
}: {
  line: Line
  home: string
  agents: YardbellState['agents']
  actions: TreeActions
  showHost: boolean
  compact?: boolean
}) {
  const [folded, setFolded] = useFlags(AGENTS_FOLDED)
  const id = `${line.machine}:${line.folder}`
  const title = line.branch || tail(line.folder)
  const where = tail(line.folder)
  const primary = Boolean(home) && line.path === home
  const meta = line.branch && where && where !== title ? where : ''
  const active = line.sessions.some((s) => keyOf(s) === actions.selected)
  const live = line.sessions.filter((s) => !s.stale)
  const grouped = compact ? line.sessions.length > 1 : line.sessions.length > 2
  const agentsOpen = !grouped || (compact ? Boolean(folded[`${id}:open`]) : !folded[id])
  const pull = line.pull as { number?: number; url?: string; forge?: string } | null
  const items: MenuEntry[] = [
    { label: 'Open', icon: PanelsTopLeft, onSelect: () => actions.onFolder(line.machine, line.folder, line.path) },
    line.path && { label: 'New session here', icon: Plus, onSelect: () => actions.onNewSession(line.machine, line.path) },
    'separator',
    line.path && { label: 'Copy path', icon: Copy, onSelect: () => copy(line.path, 'the path') },
    line.branch && { label: 'Copy branch name', icon: GitBranch, onSelect: () => copy(line.branch, 'the branch name') },
    typeof pull?.url === 'string' && { label: 'Open pull request', icon: ExternalLink, onSelect: () => window.open(String(pull.url), '_blank') },
    'separator',
    live.length > 0 && {
      label: live.length === 1 ? 'Stop session' : `Stop ${live.length} sessions`,
      icon: Square,
      danger: true,
      onSelect: async () => {
        const ok = await confirmAction({
          title: live.length === 1 ? 'Stop this session?' : `Stop ${live.length} sessions?`,
          body: 'The agents and their terminals stop. The worktree and branch stay.',
          confirm: 'Stop',
          danger: true
        })
        if (ok) live.forEach((x) => stopSession(x))
      }
    }
  ]
  return (
    <WithMenu items={items}>
      <div
        className={cn(
          'flex flex-col rounded-lg border border-transparent px-1.5 pt-1.5 pb-1 transition-[background-color,border-color,box-shadow] duration-200',
          active
            ? 'border-[color-mix(in_srgb,var(--worktree-sidebar-border)_40%,transparent)] bg-worktree-sidebar-foreground/8 shadow-[0_1px_2px_color-mix(in_srgb,var(--worktree-sidebar-foreground)_4%,transparent)] dark:border-[color-mix(in_srgb,var(--worktree-sidebar-foreground)_18%,var(--worktree-sidebar-border))] dark:bg-worktree-sidebar-foreground/10'
            : 'hover:bg-worktree-sidebar-foreground/4 dark:hover:bg-sidebar-accent/40'
        )}
      >
        <button
          type="button"
          onClick={() => actions.onFolder(line.machine, line.folder, line.path)}
          className="flex min-w-0 flex-col items-stretch gap-1 rounded-sm px-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="grid w-2.5 shrink-0 place-items-center">
              <CardDot status={line.status} />
            </span>
            <span className="min-w-0 truncate text-[13px] leading-5 font-medium text-worktree-sidebar-foreground">{title}</span>
            {primary && (
              <span className="inline-flex h-[16px] shrink-0 items-center rounded border border-foreground/20 bg-foreground/[0.06] px-1.5 text-[10px] leading-none font-medium text-foreground/70">
                primary
              </span>
            )}
            {pull?.number && (
              <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/80">
                {pull.forge === 'gitlab' ? '!' : '#'}
                {pull.number}
              </span>
            )}
          </span>
          {!compact && (showHost || meta) && (
            <span className="flex min-w-0 items-center gap-1.5 pl-[18px]">
              {showHost && <HostBadge label={line.machine} />}
              {meta && <span className="min-w-0 truncate text-[11px] leading-4 text-muted-foreground">{meta}</span>}
            </span>
          )}
        </button>
        <div className="mt-1 flex flex-col pl-3.5">
          {grouped && (
            <AgentsSummary
              sessions={line.sessions}
              open={agentsOpen}
              onToggle={() => (compact ? setFolded(`${id}:open`, !agentsOpen) : setFolded(id, agentsOpen))}
            />
          )}
          {agentsOpen && (
            <div className={cn('flex flex-col', grouped && 'ml-2 border-l border-worktree-sidebar-border/70 pl-1')}>
              {line.sessions.map((s) => (
                <AgentRow key={s.id} s={s} agents={agents} actions={actions} />
              ))}
            </div>
          )}
        </div>
      </div>
    </WithMenu>
  )
}

const headerAction =
  'grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring focus-visible:outline-none'

function ProjectBlock({
  p,
  agents,
  actions,
  showHost,
  compact
}: {
  p: ProjectNode
  agents: YardbellState['agents']
  actions: TreeActions
  showHost: boolean
  compact: boolean
}) {
  const [open, setOpen] = useFlags(OPEN)
  const isOpen = open[p.id] ?? (p.live.length > 0 || p.live.some((s) => keyOf(s) === actions.selected))
  const items: MenuEntry[] = [
    { label: 'New session', icon: Plus, onSelect: () => actions.onNewSession(p.machine, p.path) },
    { label: 'Copy path', icon: Copy, onSelect: () => copy(p.path, 'the path') },
    'separator',
    {
      label: 'Rename…',
      icon: Pencil,
      onSelect: async () => {
        const name = await askText({ title: 'Rename project', value: p.name, confirm: 'Rename' })
        if (name && name !== p.name) renameProject(p.id, name)
      }
    },
    {
      label: 'Remove from sidebar',
      icon: X,
      danger: true,
      onSelect: async () => {
        const ok = await confirmAction({
          title: `Remove ${p.name}?`,
          body: 'It leaves the sidebar. The folder and its sessions are not touched.',
          confirm: 'Remove',
          danger: true
        })
        if (ok) removeProject(p.id)
      }
    }
  ]
  return (
    <section className="pt-1">
      <WithMenu items={items}>
        <div
          role="button"
          tabIndex={0}
          aria-expanded={isOpen}
          title={p.path}
          onClick={() => setOpen(p.id, !isOpen)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
            e.preventDefault()
            setOpen(p.id, !isOpen)
          }}
          className="group/proj relative flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md pr-1 pl-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring"
        >
          <span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground">
            <FolderGit2 className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] leading-4 font-semibold text-worktree-sidebar-foreground">{p.name}</span>
          <span
            className={cn(
              'flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/proj:opacity-100 group-focus-within/proj:opacity-100',
              !isOpen && 'opacity-100'
            )}
          >
            <span className="contents" onClick={(e) => e.stopPropagation()}>
              <Hint label="New session" side="bottom">
                <button
                  type="button"
                  aria-label={`New session in ${p.name}`}
                  onClick={() => actions.onNewSession(p.machine, p.path)}
                  className={cn(headerAction, !isOpen && 'hidden group-hover/proj:grid')}
                >
                  <Plus className="size-3.5" />
                </button>
              </Hint>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label={`More for ${p.name}`} className={cn(headerAction, !isOpen && 'hidden group-hover/proj:grid')}>
                    <MoreHorizontal className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <MenuItems as="dropdown" items={items} />
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
            <span className={headerAction} aria-hidden>
              <ChevronDown className={cn('size-3.5 transition-transform', !isOpen && '-rotate-90')} />
            </span>
          </span>
        </div>
      </WithMenu>
      {isOpen && (
        <div className="flex flex-col gap-0.5 pt-0.5 pb-1">
          {p.lines.length ? (
            p.lines.map((l) => <WorktreeCard key={l.folder} line={l} home={p.path} agents={agents} actions={actions} showHost={showHost} compact={compact} />)
          ) : (
            <button
              type="button"
              onClick={() => actions.onNewSession(p.machine, p.path)}
              className="flex h-6 items-center gap-1.5 rounded-sm px-2.5 text-left text-[11px] text-muted-foreground hover:bg-worktree-sidebar-accent/55"
            >
              <Plus className="size-3" /> Start a session
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function MachineBlock({ m, agents, actions, compact }: { m: MachineNode; agents: YardbellState['agents']; actions: TreeActions; compact: boolean }) {
  const [folded, setFolded] = useFlags(FOLDED)
  const open = !folded[m.name]
  const empty = !m.projects.length && !m.other.length
  const detail = !m.up ? m.reason || 'Offline' : m.local ? 'This computer' : m.mem !== null ? `${m.mem}% memory` : ''
  const items: MenuEntry[] = [
    { label: 'New session on this machine', icon: Plus, disabled: !m.up, onSelect: () => actions.onNewSession(m.name, '') },
    { label: 'Open a shell', icon: SquareTerminal, disabled: !m.up, onSelect: () => actions.onShell(m.name) },
    'separator',
    { label: 'Open on the Dashboard', icon: House, onSelect: () => actions.onDashboard(m.name) },
    { label: 'Check now', icon: RefreshCw, onSelect: () => checkNow() }
  ]
  return (
    <section className="flex flex-col">
      <WithMenu items={items}>
        <div className="pt-1">
          <div
            role="button"
            tabIndex={0}
            aria-expanded={open}
            title={m.up ? m.name : `${m.name}: ${m.reason || 'offline'}`}
            onClick={() => setFolded(m.name, open)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
              e.preventDefault()
              setFolded(m.name, open)
            }}
            className={cn(
              'group/host-header flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border px-2 text-left transition-all outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring',
              !m.up
                ? 'border-worktree-sidebar-border/70 bg-worktree-sidebar-accent/35 text-muted-foreground'
                : 'border-worktree-sidebar-border bg-worktree-sidebar-accent/70'
            )}
          >
            {m.up ? <Server className="size-3.5 shrink-0 text-muted-foreground" /> : <ServerOff className="size-3.5 shrink-0 text-muted-foreground/80" />}
            {m.tone === 'warn' && <TriangleAlert className="size-3 shrink-0 text-status-warning-text" />}
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className={cn('min-w-0 truncate text-[12px] leading-4 font-semibold', m.up ? 'text-foreground' : 'text-muted-foreground')}>{m.name}</span>
              {detail && (
                <span
                  className={cn(
                    'shrink-0 truncate text-[10px] leading-3.5',
                    !m.up ? 'text-destructive' : m.tone === 'warn' ? 'text-status-warning-text' : 'text-muted-foreground/70'
                  )}
                >
                  {detail}
                </span>
              )}
              {m.count > 0 && (
                <span
                  aria-label={`${m.count} sessions`}
                  className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full border border-worktree-sidebar-border bg-worktree-sidebar-accent px-1.5 text-[9px] leading-none font-medium text-muted-foreground/90"
                >
                  {m.count}
                </span>
              )}
            </span>
            <span
              className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/host-header:opacity-100 group-focus-within/host-header:opacity-100"
              onClick={(e) => e.stopPropagation()}
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label={`More for ${m.name}`} className={headerAction}>
                    <MoreHorizontal className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <MenuItems as="dropdown" items={items} />
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
            {!empty && <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')} />}
          </div>
        </div>
      </WithMenu>
      {open && !empty && (
        <div className="flex flex-col pb-1.5">
          {m.projects.map((p) => (
            <ProjectBlock key={p.id} p={p} agents={agents} actions={actions} showHost={false} compact={compact} />
          ))}
          {m.other.length > 0 && (
            <section className="pt-1">
              <div className="flex h-7 items-center gap-1.5 pl-2 text-[13px] leading-4 font-semibold text-worktree-sidebar-foreground">
                <span className="flex size-4 items-center justify-center text-muted-foreground">
                  <Folder className="size-3.5" />
                </span>
                Other
              </div>
              <div className="flex flex-col px-1.5">
                {m.other.map((s) => (
                  <AgentRow key={s.id} s={s} agents={agents} actions={actions} where={tail(s.cwd || s.path || s.folder) || 'Other'} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </section>
  )
}

function StatusGroups({
  machines,
  agents,
  actions,
  compact
}: {
  machines: MachineNode[]
  agents: YardbellState['agents']
  actions: TreeActions
  compact: boolean
}) {
  const cards = machines.flatMap((m) => m.projects.flatMap((p) => p.lines.map((line) => ({ line, home: p.path }))))
  const loose = machines.flatMap((m) => m.other)
  const many = machines.length > 1
  return (
    <>
      {STATUS_GROUPS.map((g) => {
        const mine = cards.filter((c) => g.test(c.line.status))
        const strays = loose.filter((s) => g.test(statusOf(s)))
        if (!mine.length && !strays.length) return null
        return (
          <section key={g.id} className="pt-1">
            <div className="flex h-7 items-center gap-1.5 pl-2 text-[13px] leading-4 font-semibold text-worktree-sidebar-foreground">
              <span className="grid size-4 place-items-center">
                <CardDot status={g.id === 'needs' ? 'blocked' : g.id === 'working' ? 'working' : 'idle'} />
              </span>
              {g.label}
              <span className="text-[11px] font-medium text-muted-foreground tabular-nums">{mine.length + strays.length}</span>
            </div>
            <div className="flex flex-col gap-0.5 pt-0.5 pb-1">
              {mine.map(({ line, home }) => (
                <WorktreeCard
                  key={`${line.machine}:${line.folder}`}
                  line={line}
                  home={home}
                  agents={agents}
                  actions={actions}
                  showHost={many}
                  compact={compact}
                />
              ))}
              {strays.length > 0 && (
                <div className="flex flex-col px-1.5">
                  {strays.map((s) => (
                    <AgentRow
                      key={s.id}
                      s={s}
                      agents={agents}
                      actions={actions}
                      where={[many ? s.machine : null, tail(s.cwd || s.path || s.folder) || 'Other'].filter(Boolean).join(' · ')}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>
        )
      })}
    </>
  )
}

export function SessionTree({ state, actions }: { state: YardbellState | null; actions: TreeActions }) {
  const options = useTreeOptions()
  if (!state) return <p className="px-2.5 py-2 text-[12.5px] text-muted-foreground">Loading…</p>
  const all = buildTree(state)
  if (!all.length) return <p className="px-2.5 py-2 text-[12.5px] text-muted-foreground">No machines yet.</p>
  const machines = shapeTree(all, options)
  const agents = state.agents || []
  if (!machines.length)
    return (
      <div className="flex flex-col items-start gap-1 px-4 py-2 text-[12px] text-muted-foreground">
        Nothing matches the sidebar filters.
        <button
          type="button"
          onClick={() => setTreeOptions({ ...DEFAULT_OPTIONS, group: options.group, sort: options.sort, compact: options.compact })}
          className="text-foreground underline underline-offset-2"
        >
          Reset filters
        </button>
      </div>
    )
  return (
    <div className="flex flex-col px-2 pb-4">
      {options.group === 'status' ? (
        <StatusGroups machines={machines} agents={agents} actions={actions} compact={options.compact} />
      ) : (
        machines.map((m) => <MachineBlock key={m.name} m={m} agents={agents} actions={actions} compact={options.compact} />)
      )}
    </div>
  )
}
