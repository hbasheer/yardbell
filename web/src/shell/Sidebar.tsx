// Sidebar chrome adapted from Orca's sidebar (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import { useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronsDownUp, RotateCcw, SlidersHorizontal, ChevronsUpDown, FolderPlus, LogOut, Monitor, Moon, PanelLeft, Plus, Search, Settings, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/class-names'
import type { YardbellState } from '@/lib/state'
import { Hint } from '@/components/ui/tooltip'
import { AddProject } from './AddProject'
import { PAGES, type PageId } from './pages'
import { foldAllProjects, SessionTree, useAnyProjectOpen, type TreeActions } from './SessionTree'
import { THEME_WORD, type Theme } from './theme'
import { filtersOn, setTreeOptions, useTreeOptions } from './tree-options'
import { MODE_EVENT, setWorkspaceMode, workspaceMode, type Mode } from '@/workspace/layout'

const mac = /Mac|iPhone|iPad/.test(navigator.platform)
const FOLDED_KEY = 'yardbell.side.projectsFolded'
export const SIDEBAR_WIDTH = { key: 'yardbell.side.width', min: 220, normal: 256, max: 500 }

type Props = {
  page: PageId
  go: (id: PageId) => void
  state: YardbellState | null
  live: boolean
  theme: Theme
  cycleTheme: () => void
  onSearch: () => void
  onCollapse: () => void
  tree: TreeActions
  onNewSession: () => void
  width: number
  onWidth: (px: number, keep: boolean) => void
}

const dimmedIcon = 'text-worktree-sidebar-foreground opacity-30 forced-colors:opacity-100'

function KeyCaps({ keys }: { keys: string[] }) {
  return (
    <span className="pointer-events-none hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
      {keys.map((k) => (
        <kbd
          key={k}
          className="min-w-4 rounded border border-worktree-sidebar-border/80 bg-worktree-sidebar-foreground/8 px-1 py-px text-center font-sans text-[9px] text-worktree-sidebar-foreground/55"
        >
          {k}
        </kbd>
      ))}
    </span>
  )
}

function ResizeEdge({ width, onWidth }: { width: number; onWidth: Props['onWidth'] }) {
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    // Captured, because moves over a terminal or browser frame never reach this window otherwise.
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const from = e.clientX
    const was = width
    const clamp = (px: number) => Math.round(Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, px)))
    const move = (ev: PointerEvent) => onWidth(clamp(was + ev.clientX - from), false)
    const up = (ev: PointerEvent) => {
      onWidth(clamp(was + ev.clientX - from), true)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR_WIDTH.min}
        aria-valuemax={SIDEBAR_WIDTH.max}
        aria-valuenow={width}
        tabIndex={0}
        title="Drag to resize. Double-click to reset."
        onPointerDown={start}
        onDoubleClick={() => onWidth(SIDEBAR_WIDTH.normal, true)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
          e.preventDefault()
          onWidth(Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, width + (e.key === 'ArrowLeft' ? -16 : 16))), true)
        }}
        className="peer absolute top-0 -right-[9px] z-20 h-full w-[9px] cursor-col-resize outline-none"
      />
      <div className="pointer-events-none absolute top-0 -right-px z-20 h-full w-px bg-transparent transition-colors peer-hover:bg-ring/50 peer-focus-visible:bg-ring peer-active:bg-ring" />
    </>
  )
}

function Choice<T extends string>({ label, value, choices, onPick }: { label: string; value: T; choices: [T, string, string?][]; onPick: (v: T) => void }) {
  const current = choices.find(([v]) => v === value)
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex-1">{label}</span>
        <span className="text-xs text-muted-foreground">{current?.[1]}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        {choices.map(([v, name, help]) => (
          <DropdownMenuItem key={v} onSelect={() => onPick(v)} className="items-start">
            <Check className={cn('mt-px size-3.5', v !== value && 'invisible')} />
            <span className="flex flex-col">
              <span>{name}</span>
              {help && <span className="text-[11px] text-muted-foreground">{help}</span>}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault()
        onChange(!on)
      }}
    >
      <Check className={cn('size-3.5', !on && 'invisible')} />
      {label}
    </DropdownMenuItem>
  )
}

function useWorkspaceMode(): Mode {
  const [mode, setMode] = useState<Mode>(workspaceMode)
  useEffect(() => {
    const changed = () => setMode(workspaceMode())
    window.addEventListener(MODE_EVENT, changed)
    return () => window.removeEventListener(MODE_EVENT, changed)
  }, [])
  return mode
}

function OptionsMenu({ state }: { state: YardbellState | null }) {
  const o = useTreeOptions()
  const mode = useWorkspaceMode()
  const filters = filtersOn(o)
  const machines = state?.machines || []
  return (
    <DropdownMenu modal={false}>
      <Hint label="Session options" side="bottom">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={filters ? `Session options, ${filters} filters on` : 'Session options'} className="relative text-muted-foreground">
            <SlidersHorizontal className="size-3.5" strokeWidth={2.25} />
            {filters > 0 && <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-foreground" />}
          </Button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="w-72 pb-2">
        <DropdownMenuLabel>Session options</DropdownMenuLabel>
        <Choice
          label="Group by"
          value={o.group}
          choices={[
            ['machine', 'Machine', 'Machines, then projects, then worktrees.'],
            ['status', 'Status', 'Needs you, Working and Idle, across machines.']
          ]}
          onPick={(group) => setTreeOptions({ group })}
        />
        <Choice
          label="Sort by"
          value={o.sort}
          choices={[
            ['manual', 'Manual', 'Projects in the order you added them.'],
            ['name', 'Name'],
            ['activity', 'Agent activity', 'Agents that need you first, then working ones.']
          ]}
          onPick={(sort) => setTreeOptions({ sort })}
        />
        <Choice
          label="Machines"
          value={o.machine || 'all'}
          choices={[['all', 'All machines'], ...machines.map((m): [string, string, string?] => [m.name, m.name, m.up ? (m.local ? 'This computer' : undefined) : 'Offline'])]}
          onPick={(v) => setTreeOptions({ machine: v === 'all' ? '' : v })}
        />
        <Choice
          label="Workspace"
          value={mode}
          choices={[
            ['shared', 'One for everything', 'Every session, terminal and file in one set of tabs. The right panel follows the tab you are on.'],
            ['folder', 'One per folder', 'Each worktree keeps its own tabs and splits, as in Orca.']
          ]}
          onPick={(m) => setWorkspaceMode(m)}
        />
        <Choice
          label="Card style"
          value={o.compact ? 'compact' : 'comfortable'}
          choices={[
            ['comfortable', 'Comfortable', 'Branch, folder and every agent on its own row.'],
            ['compact', 'Compact', 'One line per worktree, agents folded into a pill.']
          ]}
          onPick={(v) => setTreeOptions({ compact: v === 'compact' })}
        />
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Filters</DropdownMenuLabel>
        <Toggle label="Hide idle sessions" on={o.hideIdle} onChange={(hideIdle) => setTreeOptions({ hideIdle })} />
        <Toggle label="Hide Other" on={o.hideOther} onChange={(hideOther) => setTreeOptions({ hideOther })} />
        <Toggle label="Hide offline machines" on={o.hideOffline} onChange={(hideOffline) => setTreeOptions({ hideOffline })} />
        <Toggle label="Hide projects with no sessions" on={o.hideEmpty} onChange={(hideEmpty) => setTreeOptions({ hideEmpty })} />
        {filters > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setTreeOptions({ machine: '', hideIdle: false, hideOther: false, hideOffline: false, hideEmpty: false })}>
              <RotateCcw className="size-3.5" /> Reset filters
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Sidebar({ page, go, state, live, theme, cycleTheme, onSearch, onCollapse, tree, onNewSession, width, onWidth }: Props) {
  const proposals = state?.proposals?.length ?? 0
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor
  const [folded, setFolded] = useState(() => localStorage.getItem(FOLDED_KEY) === '1')
  const [adding, setAdding] = useState(false)
  const anyOpen = useAnyProjectOpen(state)

  const fold = () => {
    setFolded(!folded)
    try {
      localStorage.setItem(FOLDED_KEY, folded ? '0' : '1')
    } catch {}
  }

  const logout = async () => {
    await fetch('/logout', { method: 'POST' }).catch(() => {})
    location.href = '/login'
  }

  return (
    <aside className="relative flex min-h-0 flex-col border-r border-worktree-sidebar-border bg-worktree-sidebar text-worktree-sidebar-foreground">
      <div className="flex h-10 shrink-0 items-center gap-1.5 px-2">
        <Hint label="Collapse sidebar">
          <Button variant="ghost" size="icon-xs" onClick={onCollapse} aria-label="Collapse sidebar" className="text-muted-foreground">
            <PanelLeft className="size-3.5" />
          </Button>
        </Hint>
        <a
          href="/ui/"
          onClick={(e) => {
            e.preventDefault()
            go('dashboard')
          }}
          className="text-[13px] font-semibold tracking-tight"
        >
          Yardbell
        </a>
      </div>

      <div className="flex flex-col gap-0.5 px-2 pt-1 pb-1">
        <button
          type="button"
          onClick={onSearch}
          aria-label="Search sessions, projects and pages"
          className="group flex w-full items-center gap-2 rounded-md bg-worktree-sidebar-foreground/5 px-2 py-1.5 text-left text-[13px] font-medium tracking-tight text-worktree-sidebar-foreground/60 transition-colors hover:bg-worktree-sidebar-foreground/8"
        >
          <Search className={cn('size-4 shrink-0', dimmedIcon)} strokeWidth={1.75} />
          <span className="flex-1">Search</span>
          <KeyCaps keys={mac ? ['⌘', 'K'] : ['Ctrl', 'K']} />
        </button>
        <nav className="flex flex-col gap-0.5" aria-label="Pages">
          {PAGES.filter((p) => p.nav || (p.id === 'proposals' && proposals > 0)).map((p) => {
            const active = page === p.id
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => go(p.id)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
                  active ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground' : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
                )}
              >
                <p.icon className={cn('size-4 shrink-0', !active && dimmedIcon)} strokeWidth={active ? 2.25 : 1.75} />
                <span className="flex-1">{p.name}</span>
                {p.id === 'proposals' && <span className="rounded-full bg-status-warning px-1.5 text-3xs leading-4 font-semibold text-background">{proposals}</span>}
              </button>
            )
          })}
        </nav>
      </div>

      <div className="group/sidebar-header mt-2 flex h-8 min-w-0 shrink-0 items-center justify-between gap-1.5 px-2">
        <div className="group/section-header relative flex h-full min-w-0 flex-1 items-center gap-1">
          <Hint label={folded ? 'Expand Sessions' : 'Collapse Sessions'} side="bottom">
            <button
              type="button"
              onClick={(e) => {
                fold()
                if (e.detail > 0) e.currentTarget.blur()
              }}
              aria-label={folded ? 'Expand Sessions' : 'Collapse Sessions'}
              aria-expanded={!folded}
              className="peer absolute inset-0 cursor-pointer rounded-md focus-visible:ring-2 focus-visible:ring-worktree-sidebar-ring focus-visible:outline-none"
            />
          </Hint>
          <ChevronDown
            className={cn(
              'pointer-events-none size-3 shrink-0 text-muted-foreground/80 opacity-0 transition group-hover/section-header:opacity-100',
              folded && '-rotate-90 opacity-100'
            )}
          />
          <span className="pointer-events-none min-w-0 truncate pr-0.5 text-xs font-semibold text-muted-foreground/80 select-none">Sessions</span>
          {!folded && (
            <Hint label={anyOpen ? 'Collapse all projects' : 'Expand all projects'} side="bottom">
              <button
                type="button"
                onClick={() => foldAllProjects(state, !anyOpen)}
                aria-label={anyOpen ? 'Collapse all projects' : 'Expand all projects'}
                className="relative grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/sidebar-header:opacity-100 hover:bg-worktree-sidebar-foreground/8 hover:text-foreground focus-visible:opacity-100"
              >
                {anyOpen ? <ChevronsDownUp className="size-3" /> : <ChevronsUpDown className="size-3" />}
              </button>
            </Hint>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <OptionsMenu state={state} />
          <Hint label="Add project" side="bottom">
            <Button variant="ghost" size="icon-xs" onClick={() => setAdding(true)} aria-label="Add project" className="text-muted-foreground">
              <FolderPlus className="size-3.5" strokeWidth={2.25} />
            </Button>
          </Hint>
          <Hint label={`New session · ${mac ? '⌘' : 'Ctrl+'}N`} side="bottom">
            <Button variant="ghost" size="icon-xs" onClick={onNewSession} aria-label="New session" className="text-muted-foreground">
              <Plus className="size-3.5" strokeWidth={2.25} />
            </Button>
          </Hint>
        </div>
      </div>

      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
        {!folded && <SessionTree state={state} actions={tree} />}
      </div>

      <div className="mt-auto shrink-0">
        <div className="flex items-center justify-between border-t border-worktree-sidebar-border px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-1">
            <Hint label="Settings" side="top">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => go('settings')}
                aria-label="Settings"
                aria-current={page === 'settings' ? 'page' : undefined}
                className={cn('text-muted-foreground', page === 'settings' && 'bg-accent text-foreground')}
              >
                <Settings className="size-3.5" />
              </Button>
            </Hint>
            <Hint label={THEME_WORD[theme]} side="top">
              <Button variant="ghost" size="icon-xs" onClick={cycleTheme} aria-label={THEME_WORD[theme]} className="text-muted-foreground">
                <ThemeIcon className="size-3.5" />
              </Button>
            </Hint>
            <Hint label="Log out" side="top">
              <Button variant="ghost" size="icon-xs" onClick={logout} aria-label="Log out" className="text-muted-foreground">
                <LogOut className="size-3.5" />
              </Button>
            </Hint>
          </div>
          <div className="flex items-center gap-1">
            <Hint label={live ? 'Live' : 'Reconnecting'} side="top">
              <span role="img" aria-label={live ? 'Live' : 'Reconnecting'} className="grid size-6 place-items-center">
                <span className={cn('size-2 rounded-full', live ? 'bg-status-success' : 'bg-status-warning')} />
              </span>
            </Hint>
          </div>
        </div>
      </div>

      <ResizeEdge width={width} onWidth={onWidth} />
      <AddProject open={adding} state={state} onClose={() => setAdding(false)} />
    </aside>
  )
}
