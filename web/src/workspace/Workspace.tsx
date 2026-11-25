import { useEffect, useRef, useState } from 'react'
import { Bot, Columns2, Copy, FileText, Globe, LayoutGrid, MessageSquare, PanelRight, Pencil, Plus, Rows2, Square, SquareTerminal, X } from 'lucide-react'
import { cn } from '@/lib/class-names'
import type { YardbellState } from '@/lib/state'
import { keyOf, statusOf, type Status } from '@/lib/tree'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { later, MenuItems, type MenuEntry } from '@/components/ui/menu-items'
import { Hint } from '@/components/ui/tooltip'
import { copy, openShell, startSession, stopSession } from '@/lib/actions'
import { askText, confirmAction } from '@/lib/confirm'
import { StatusIcon } from '@/shell/SessionTree'
import {
  activate,
  activeItem,
  closeGroup,
  closeItem,
  closeOthers,
  currentSpace,
  dockSession,
  focusGroup,
  focusedGroup,
  groups,
  isSplit,
  itemName,
  itemStatus,
  moveItem,
  openItem,
  openSession,
  placeOfSpace,
  placeOfItem,
  SHARED,
  setRatio,
  splitGroup,
  title,
  updateItem,
  type Group,
  type Item,
  type Layouts,
  type Node,
  type Side
} from './layout'
import type { WorkspaceStore } from './useWorkspace'
import { browserPrefs } from '@/lib/browser-prefs'
import { BrowserView } from './BrowserView'
import { DiffView } from './DiffView'
import { FileView } from './FileView'
import { NewTerminal } from './NewTerminal'
import { RightPanel, type PanelTab } from './RightPanel'
import type { Place } from './SendNotes'

type Box = { x: number; y: number; w: number; h: number }
type Placed = { group: Group; box: Box }
type Divider = { path: number[]; dir: 'row' | 'col'; box: Box; at: number }

export const DRAG_ITEM = 'application/x-yardbell-tab'
export const DRAG_SESSION = 'application/x-yardbell-session'

function rects(node: Node, box: Box, path: number[], out: { groups: Placed[]; splits: Divider[] }) {
  if (!isSplit(node)) {
    out.groups.push({ group: node, box })
    return out
  }
  const r = node.ratio
  const [a, b] =
    node.split === 'row'
      ? [
          { ...box, w: box.w * r },
          { ...box, x: box.x + box.w * r, w: box.w * (1 - r) }
        ]
      : [
          { ...box, h: box.h * r },
          { ...box, y: box.y + box.h * r, h: box.h * (1 - r) }
        ]
  out.splits.push({ path, dir: node.split, box, at: node.split === 'row' ? b.x : b.y })
  rects(node.a, a, [...path, 0], out)
  rects(node.b, b, [...path, 1], out)
  return out
}

const pct = (n: number) => `${n * 100}%`
const termSrc = (key: string) => {
  const [machine, ...rest] = key.split('/')
  return `/term/${encodeURIComponent(machine)}/${encodeURIComponent(rest.join('/'))}?embed=1`
}

// The edge of a pane the pointer is nearest picks where a dropped tab goes; its middle puts it in the pane's own strip.
function zoneAt(e: React.DragEvent, el: HTMLElement): Side | 'center' {
  const r = el.getBoundingClientRect()
  const x = (e.clientX - r.left) / r.width
  const y = (e.clientY - r.top) / r.height
  const edges: [Side, number][] = [
    ['left', x],
    ['right', 1 - x],
    ['up', y],
    ['down', 1 - y]
  ]
  const [side, d] = edges.sort((a, b) => a[1] - b[1])[0]
  return d < 0.25 ? side : 'center'
}

const DROP_BOX: Record<Side | 'center', string> = {
  left: 'inset-y-0 left-0 w-1/2',
  right: 'inset-y-0 right-0 w-1/2',
  up: 'inset-x-0 top-0 h-1/2',
  down: 'inset-x-0 bottom-0 h-1/2',
  center: 'inset-0'
}

function TabIcon({ item, status }: { item: Item; status: Status }) {
  if (item.kind === 'dispatch') return <MessageSquare className="size-3.5 text-muted-foreground" />
  if (item.kind === 'browser') return <Globe className="size-3.5 text-muted-foreground" />
  if (item.kind === 'file' || item.kind === 'diff') return <FileText className="size-3.5 text-muted-foreground" />
  if (!status) return <SquareTerminal className="size-3.5 text-muted-foreground" />
  return <StatusIcon status={status} />
}

export type Actions = {
  agents: { name: string; label: string }[]
  defaultAgent?: string
  place: Place | null
  onAgent: (agent: string, group: string) => void
  onNewSession: () => void
  onTerminal: (group: string) => void
  onBrowser: (group: string) => void
  onDispatch: (group: string) => void
  onOpenFile: () => void
}

const stripButton = 'my-auto grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground'

function NewTabMenu({ actions, group }: { actions: Actions; group: string }) {
  const here = actions.place ? actions.place.path.split('/').pop() : null
  const main = actions.agents.find((a) => a.name === actions.defaultAgent) ?? actions.agents[0]
  const ordered = main ? [main, ...actions.agents.filter((a) => a !== main)] : actions.agents
  return (
    <DropdownMenu>
      <Hint label="New tab">
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="New tab" className={cn(stripButton, 'mx-1')}>
            <Plus className="size-4" />
          </button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="start" className="min-w-[15rem]">
        <DropdownMenuItem onSelect={() => later(actions.onNewSession)}>
          <Plus /> New session… <DropdownMenuShortcut>Alt+N</DropdownMenuShortcut>
        </DropdownMenuItem>
        {ordered.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!actions.place}>
              <Bot /> Quick start{here ? ` in ${here}` : ''}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {ordered.map((a) => (
                <DropdownMenuItem key={a.name} onSelect={() => actions.onAgent(a.name, group)}>
                  {a.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => actions.onTerminal(group)}>
          <SquareTerminal /> New Terminal
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onBrowser(group)}>
          <Globe /> New Browser Tab
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onDispatch(group)}>
          <MessageSquare /> New Dispatch chat
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!actions.place} onSelect={actions.onOpenFile}>
          <FileText /> Open file…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function EmptyGroup({ store, state, group, actions }: { store: WorkspaceStore; state: YardbellState | null; group: Group; actions: Actions }) {
  const sp = currentSpace(store.layout)
  const here = new Set(sp ? groups(sp.root).flatMap((g) => g.items.map((i) => i.key)) : [])
  const others = (state?.sessions || []).filter((s) => s.tmux && s.attachable && !s.stale && !here.has(keyOf(s)))
  const main = actions.agents.find((a) => a.name === actions.defaultAgent) ?? actions.agents[0]
  const choice =
    'flex h-8 items-center gap-2 rounded-md border border-border px-2.5 text-left text-[13px] hover:bg-accent disabled:pointer-events-none disabled:opacity-40'
  return (
    <div className="grid size-full place-items-center overflow-auto p-6">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <div className="grid justify-items-center gap-1 text-center">
          <span className="mb-1 grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground">
            <LayoutGrid className="size-5" />
          </span>
          <p className="text-sm font-medium">Nothing open here</p>
          <p className="text-xs text-muted-foreground">
            {actions.place ? (
              <>
                Start something in <span className="font-mono text-foreground/80">{actions.place.path.replace(/^\/(home|Users)\/[^/]+/, '~')}</span> on {actions.place.machine}.
              </>
            ) : (
              'Pick a folder in the sidebar to start an agent there, or open a terminal, a browser or Dispatch.'
            )}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {main && (
            <button type="button" disabled={!actions.place} onClick={() => actions.onAgent(main.name, group.group)} className={choice}>
              <Bot className="size-4 text-muted-foreground" /> {main.label}
            </button>
          )}
          <button type="button" onClick={() => actions.onTerminal(group.group)} className={choice}>
            <SquareTerminal className="size-4 text-muted-foreground" /> Terminal
          </button>
          <button type="button" onClick={() => actions.onBrowser(group.group)} className={choice}>
            <Globe className="size-4 text-muted-foreground" /> Browser
          </button>
          <button type="button" onClick={() => actions.onDispatch(group.group)} className={choice}>
            <MessageSquare className="size-4 text-muted-foreground" /> Dispatch
          </button>
        </div>
        {others.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">Other running sessions</p>
            {others.slice(0, 8).map((s) => (
              <button key={s.id} type="button" onClick={() => store.update((l) => openSession(l, keyOf(s), state, group.group))} className={choice}>
                <StatusIcon status={statusOf(s)} />
                <span className="min-w-0 flex-1 truncate">{title(s)}</span>
                <span className="text-2xs text-muted-foreground">{s.machine}</span>
              </button>
            ))}
          </div>
        )}
        <p className="text-center text-xs text-muted-foreground">Drag a tab here, or open a file or a diff from the panel on the right.</p>
      </div>
    </div>
  )
}

function ItemBody({ item, store, state, place }: { item: Item; store: WorkspaceStore; state: YardbellState | null; place: Place | null }) {
  if (item.kind === 'session' && item.key)
    return <iframe title={`Terminal for ${itemName(item, state)}`} src={termSrc(item.key)} data-key={item.key} className="size-full border-0" />
  if (item.kind === 'dispatch')
    return <iframe title="Dispatch" src={`/dispatch${item.conversation ? `?c=${encodeURIComponent(item.conversation)}` : ''}`} className="size-full border-0" />
  if (item.kind === 'file') return <FileView machine={item.machine!} root={item.root!} path={item.path!} onDirty={() => {}} />
  if (item.kind === 'diff') return <DiffView machine={item.machine!} root={item.root!} path={item.path!} staged={Boolean(item.staged)} state={state} />
  if (item.kind === 'browser')
    return <BrowserView url={item.url || ''} place={place} state={state} onUrl={(url) => store.update((l) => updateItem(l, item.id, { url }))} />
  return null
}

// Closing a tab only closes the tab. A session keeps running and reopens from the sidebar.
function closeTab(item: Item, update: (fn: (l: Layouts) => Layouts) => void) {
  update((l) => closeItem(l, item.id))
}

function GroupView({
  group,
  store,
  state,
  actions,
  focused,
  only,
  reserveRight,
  dragging,
  onDragEnd
}: {
  group: Group
  store: WorkspaceStore
  state: YardbellState | null
  actions: Actions
  focused: boolean
  only: boolean
  reserveRight: boolean
  dragging: boolean
  onDragEnd: () => void
}) {
  const { update } = store
  const [zone, setZone] = useState<Side | 'center' | null>(null)
  const [stripAt, setStripAt] = useState<number | null>(null)
  const strip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [group.active])

  const dropped = (e: React.DragEvent, side: Side | 'center', index?: number) => {
    e.preventDefault()
    const item = e.dataTransfer.getData(DRAG_ITEM)
    const key = e.dataTransfer.getData(DRAG_SESSION)
    if (item) update((l) => moveItem(l, item, group.group, side, index))
    else if (key) update((l) => dockSession(l, key, group.group, side))
    setZone(null)
    setStripAt(null)
    onDragEnd()
  }

  const tabMenu = (item: Item): MenuEntry[] => {
    const s = item.kind === 'session' ? state?.sessions.find((x) => keyOf(x) === item.key) : null
    const doc = item.kind === 'file' || item.kind === 'diff' ? item : null
    return [
      {
        label: 'Rename tab…',
        icon: Pencil,
        onSelect: async () => {
          const name = await askText({ title: 'Rename tab', value: itemName(item, state), confirm: 'Rename' })
          if (name) update((l) => updateItem(l, item.id, { name }))
        }
      },
      doc && { label: 'Copy path', icon: Copy, onSelect: () => copy(`${doc.root!.replace(/\/$/, '')}/${doc.path}`, 'the path') },
      doc && { label: 'Copy relative path', icon: Copy, onSelect: () => copy(doc.path!, 'the relative path') },
      s && { label: 'Copy session name', icon: Copy, onSelect: () => copy(s.tmux || '', 'the session name') },
      'separator',
      group.items.length > 1 && { label: 'Split right', icon: Columns2, onSelect: () => update((l) => moveItem(l, item.id, group.group, 'right')) },
      group.items.length > 1 && { label: 'Split down', icon: Rows2, onSelect: () => update((l) => moveItem(l, item.id, group.group, 'down')) },
      'separator',
      s && {
        label: 'Stop session',
        icon: Square,
        danger: true,
        onSelect: async () => {
          if (
            await confirmAction({
              title: `Stop ${title(s)}?`,
              body: 'The agent and its terminal stop. The worktree and branch stay.',
              confirm: 'Stop',
              danger: true
            })
          )
            stopSession(s)
        }
      },
      { label: 'Close others', disabled: group.items.length < 2, onSelect: () => update((l) => closeOthers(l, group.group, item.id)) },
      { label: 'Close', icon: X, shortcut: 'Alt+X', onSelect: () => closeTab(item, update) }
    ]
  }

  return (
    <div className="flex size-full flex-col" onPointerDown={() => update((l) => focusGroup(l, group.group))}>
      <div
        className="flex h-8 shrink-0 items-stretch border-b border-border bg-tab-bar"
        onDragOver={(e) => {
          if (!dragging) return
          e.preventDefault()
          const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role=tab]')]
          const at = tabs.findIndex((t) => e.clientX < t.getBoundingClientRect().left + t.offsetWidth / 2)
          setStripAt(at < 0 ? tabs.length : at)
        }}
        onDragLeave={() => setStripAt(null)}
        onDrop={(e) => dropped(e, 'center', stripAt ?? undefined)}
      >
        <div
          ref={strip}
          className="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]"
          role="tablist"
          aria-label="Tabs"
          onWheel={(e) => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
          }}
        >
          {group.items.map((item, i) => {
            const active = item.id === group.active
            return (
              <ContextMenu key={item.id}>
                <ContextMenuTrigger asChild>
                  <div
                    role="tab"
                    aria-selected={active}
                    tabIndex={active ? 0 : -1}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_ITEM, item.id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onClick={() => update((l) => activate(l, group.group, item.id))}
                    onAuxClick={(e) => e.button === 1 && closeTab(item, update)}
                    className={cn(
                      'group/tab relative flex h-full w-[220px] min-w-[150px] shrink cursor-pointer items-center gap-1.5 border-r border-border px-2.5 text-xs select-none',
                      active ? 'bg-tab-active text-tab-active-foreground' : 'bg-tab-inactive text-tab-inactive-foreground hover:text-tab-active-foreground',
                      stripAt === i && 'shadow-[inset_2px_0_0_var(--ring)]'
                    )}
                  >
                    <TabIcon item={item} status={itemStatus(item, state)} />
                    <span className="min-w-0 flex-1 truncate" title={itemName(item, state)}>
                      {itemName(item, state)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Close ${itemName(item, state)}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(item, update)
                      }}
                      className={cn(
                        'grid size-[18px] place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground',
                        !active && 'opacity-0 group-hover/tab:opacity-100'
                      )}
                    >
                      <X className="size-3" />
                    </button>
                    {active && focused && <span className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-tab-active-indicator" />}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <MenuItems as="context" items={tabMenu(item)} />
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
          <div className={cn('flex shrink-0', stripAt === group.items.length && group.items.length > 0 && 'shadow-[inset_2px_0_0_var(--ring)]')}>
            <NewTabMenu actions={actions} group={group.group} />
          </div>
        </div>
        {only ? (
          reserveRight && <span className="w-9 shrink-0" />
        ) : (
          <Hint label="Close split pane, its tabs move next door">
            <button
              type="button"
              aria-label="Close split pane"
              onClick={() => update((l) => closeGroup(l, group.group))}
              className={cn(stripButton, reserveRight ? 'mr-10' : 'mr-1.5')}
            >
              <X className="size-4" />
            </button>
          </Hint>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {group.items.map((item) => (
          <div key={item.id} className="absolute inset-0" hidden={item.id !== group.active}>
            <ItemBody item={item} store={store} state={state} place={actions.place} />
          </div>
        ))}
        {!group.items.length && <EmptyGroup store={store} state={state} group={group} actions={actions} />}
        {dragging && (
          <div
            className="absolute inset-0 z-10"
            onDragOver={(e) => {
              e.preventDefault()
              const z = zoneAt(e, e.currentTarget)
              if (z !== zone) setZone(z)
            }}
            onDragLeave={() => setZone(null)}
            onDrop={(e) => dropped(e, zoneAt(e, e.currentTarget))}
          >
            {zone && <div className={cn('pointer-events-none absolute rounded-md border-2 border-ring/70 bg-ring/15', DROP_BOX[zone])} />}
          </div>
        )}
      </div>
    </div>
  )
}

const PANEL = 'workspace.side'
type PanelPrefs = { open: boolean; tab: PanelTab; width: number }

function readPanel(): PanelPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PANEL) || '{}')
    const tabs: PanelTab[] = ['files', 'agents', 'changes', 'checks', 'ports']
    return { open: Boolean(raw.open), tab: tabs.includes(raw.tab) ? raw.tab : 'files', width: Number(raw.width) || 320 }
  } catch {
    return { open: false, tab: 'files', width: 320 }
  }
}

export function Workspace({
  store,
  state,
  visible,
  onNewSessionDialog
}: {
  store: WorkspaceStore
  state: YardbellState | null
  visible: boolean
  onNewSessionDialog: (machine?: string, path?: string) => void
}) {
  const { layout, update } = store
  const area = useRef<HTMLDivElement>(null)
  const [panel, setPanel] = useState<PanelPrefs>(readPanel)
  const [findSignal, setFindSignal] = useState(0)
  const [terminalFor, setTerminalFor] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const changePanel = (next: Partial<PanelPrefs>) =>
    setPanel((p) => {
      const merged = { ...p, ...next }
      try {
        localStorage.setItem(PANEL, JSON.stringify(merged))
      } catch {}
      return merged
    })

  const sp = currentSpace(layout)
  const focused = sp ? focusedGroup(sp) : null
  const lastPlace = useRef<Place | null>(null)
  const place = placeOfSpace(layout.current) ?? placeOfItem(focused ? activeItem(focused) : null, state) ?? (layout.current === SHARED ? lastPlace.current : null)
  if (place) lastPlace.current = place
  const ctx = useRef({ place, focused })
  ctx.current = { place, focused }

  const focusedSession = focused ? state?.sessions.find((s) => keyOf(s) === activeItem(focused)?.key) : undefined
  const actions: Actions = {
    agents: state?.agents ?? [],
    defaultAgent: (state as { default_agent?: string } | null)?.default_agent,
    place,
    onAgent: async (agent, group) => {
      if (!place) return
      const key = await startSession({ machine: place.machine, path: place.path, agent })
      if (key) update((l) => openSession(l, key, state, group))
    },
    onNewSession: () => onNewSessionDialog(place?.machine, place?.path),
    onTerminal: (group) => later(() => setTerminalFor(group)),
    onBrowser: (group) => {
      const port = (focusedSession as { ports?: { local?: number }[] } | undefined)?.ports?.find((p) => p.local)
      update((l) => openItem(l, { kind: 'browser', url: port ? `${location.protocol}//${location.hostname}:${port.local}` : browserPrefs().home }, group))
    },
    onDispatch: (group) => update((l) => openItem(l, { kind: 'dispatch' }, group)),
    onOpenFile: () => {
      changePanel({ open: true, tab: 'files' })
      setFindSignal((n) => n + 1)
    }
  }

  // Frames swallow drag events, so while a tab or session is dragged the panes take them instead.
  useEffect(() => {
    const start = (e: DragEvent) => {
      const types = e.dataTransfer?.types ?? []
      if (types.includes(DRAG_ITEM) || types.includes(DRAG_SESSION)) setDragging(true)
    }
    const end = () => setDragging(false)
    window.addEventListener('dragstart', start)
    window.addEventListener('dragend', end)
    window.addEventListener('drop', end)
    return () => {
      window.removeEventListener('dragstart', start)
      window.removeEventListener('dragend', end)
      window.removeEventListener('drop', end)
    }
  }, [])

  // Terminals forward Alt shortcuts and say when they take focus, since keys typed in a frame never reach this page.
  useEffect(() => {
    const shortcut = (code: string) => {
      const g = ctx.current.focused
      if (!g) return false
      const at = g.items.findIndex((i) => i.id === g.active)
      const step = (by: number) => g.items.length && update((l) => activate(l, g.group, g.items[(at + by + g.items.length) % g.items.length].id))
      const run: Record<string, () => void> = {
        Backslash: () => update((l) => splitGroup(l, g.group, 'right')),
        Minus: () => update((l) => splitGroup(l, g.group, 'down')),
        KeyX: () => {
          const item = g.items.find((i) => i.id === g.active)
          if (item) closeTab(item, update)
          else update((l) => closeGroup(l, g.group))
        },
        KeyN: () => onNewSessionDialog(ctx.current.place?.machine, ctx.current.place?.path),
        BracketLeft: () => step(-1),
        BracketRight: () => step(1)
      }
      run[code]?.()
      return Boolean(run[code])
    }
    const heard = (e: MessageEvent) => {
      if (e.origin !== location.origin) return
      if (e.data?.yardbell === 'key') shortcut(String(e.data.code))
      if (e.data?.yardbell === 'focused') {
        const frame = [...(area.current?.querySelectorAll('iframe') ?? [])].find((f) => f.contentWindow === e.source)
        const group = frame?.closest<HTMLElement>('[data-group]')?.dataset.group
        if (group) update((l) => focusGroup(l, group))
      }
    }
    const key = (e: KeyboardEvent) => {
      if (!visible || !e.altKey || e.ctrlKey || e.metaKey) return
      if (shortcut(e.code)) e.preventDefault()
    }
    window.addEventListener('message', heard)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('message', heard)
      window.removeEventListener('keydown', key)
    }
  }, [update, visible, onNewSessionDialog])

  const freezeFrames = (on: boolean) => area.current?.classList.toggle('[&_iframe]:pointer-events-none', on)

  const drag = (e: React.PointerEvent, d: Divider) => {
    e.preventDefault()
    const box = area.current!.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      const at = d.dir === 'row' ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height
      const span = d.dir === 'row' ? d.box.w : d.box.h
      const start = d.dir === 'row' ? d.box.x : d.box.y
      update((l) => setRatio(l, d.path, (at - start) / span))
    }
    const up = () => {
      freezeFrames(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    freezeFrames(true)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const grip = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = panel.width
    const move = (ev: PointerEvent) => changePanel({ width: Math.min(640, Math.max(240, startW + startX - ev.clientX)) })
    const up = () => {
      freezeFrames(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    freezeFrames(true)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (!sp) return <div className="grid flex-1 place-items-center text-sm text-muted-foreground">Pick a session or a worktree in the sidebar.</div>

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div ref={area} className="relative min-h-0 min-w-0 flex-1 bg-background">
        {Object.entries(layout.spaces).map(([key, space]) => {
          const shown = key === layout.current
          const placed = rects(space.root, { x: 0, y: 0, w: 1, h: 1 }, [], { groups: [], splits: [] })
          const many = placed.groups.length > 1
          return (
            <div key={key} className="absolute inset-0" hidden={!shown}>
              {placed.groups.map(({ group, box }) => (
                <section
                  key={group.group}
                  data-group={group.group}
                  className="absolute overflow-hidden"
                  style={{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) }}
                >
                  <GroupView
                    group={group}
                    store={store}
                    state={state}
                    actions={actions}
                    focused={shown && (!many || group.group === space.focus)}
                    only={!many}
                    reserveRight={!panel.open && box.y === 0 && Math.abs(box.x + box.w - 1) < 1e-6}
                    dragging={dragging && shown}
                    onDragEnd={() => setDragging(false)}
                  />
                </section>
              ))}
              {shown &&
                placed.splits.map((d) => (
                  <div
                    key={d.path.join('.') || 'root'}
                    role="separator"
                    aria-orientation={d.dir === 'row' ? 'vertical' : 'horizontal'}
                    onPointerDown={(e) => drag(e, d)}
                    className={cn(
                      'absolute z-[2] bg-border hover:bg-ring',
                      d.dir === 'row'
                        ? 'w-px cursor-col-resize before:absolute before:inset-y-0 before:-inset-x-[7px]'
                        : 'h-px cursor-row-resize before:absolute before:inset-x-0 before:-inset-y-[7px]'
                    )}
                    style={
                      d.dir === 'row'
                        ? { left: pct(d.at), top: pct(d.box.y), height: pct(d.box.h) }
                        : { top: pct(d.at), left: pct(d.box.x), width: pct(d.box.w) }
                    }
                  />
                ))}
            </div>
          )
        })}
        {!panel.open && (
          <Hint label="Show the right sidebar">
            <button
              type="button"
              aria-label="Show the right sidebar"
              onClick={() => changePanel({ open: true })}
              className="absolute top-0 right-0 z-20 grid h-8 w-9 place-items-center border-b border-l border-border bg-tab-bar text-muted-foreground hover:text-foreground"
            >
              <PanelRight className="size-4" />
            </button>
          </Hint>
        )}
      </div>
      {panel.open && (
        <div className="relative flex shrink-0" style={{ width: panel.width }}>
          <div role="separator" aria-orientation="vertical" onPointerDown={grip} className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize" />
          <RightPanel
            place={place}
            state={state}
            tab={panel.tab}
            onTab={(tab) => changePanel({ tab })}
            findSignal={findSignal}
            onResumed={(key) => update((l) => openSession(l, key, state))}
            onClose={() => changePanel({ open: false })}
            onOpenFile={(path) =>
              place && update((l) => openItem(l, { kind: 'file', machine: place.machine, root: place.path, path }, ctx.current.focused?.group))
            }
            onOpenDiff={(path, staged) =>
              place && update((l) => openItem(l, { kind: 'diff', machine: place.machine, root: place.path, path, staged }, ctx.current.focused?.group))
            }
          />
        </div>
      )}
      <NewTerminal
        open={terminalFor !== null}
        state={state}
        preferred={place?.machine}
        onClose={() => setTerminalFor(null)}
        onOpen={async (machine) => {
          const key = await openShell(machine)
          const group = terminalFor ?? undefined
          if (key) update((l) => openSession(l, key, state, group))
        }}
      />
    </div>
  )
}
