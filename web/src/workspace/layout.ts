import type { Session, YardbellState } from '@/lib/state'
import { keyOf, statusOf, worst, type Status } from '@/lib/tree'

// Orca's model: each worktree has its own layout; a layout splits into tab groups; each group has
// its own tab strip, and each tab holds one thing.
export type Kind = 'session' | 'file' | 'diff' | 'browser' | 'dispatch'
export type Item = {
  id: string
  kind: Kind
  key?: string
  machine?: string
  root?: string
  path?: string
  staged?: boolean
  url?: string
  conversation?: string
  name?: string
}
export type Group = { group: string; items: Item[]; active: string | null }
export type Split = { split: 'row' | 'col'; ratio: number; a: Node; b: Node }
export type Node = Group | Split
export type Space = { root: Node; focus: string }
export type Layouts = { spaces: Record<string, Space>; current: string; hidden: string[] }
export type Side = 'right' | 'left' | 'down' | 'up'

const STORE = 'yardbell.ui.layouts.v1'
// A session missing from a few checks in a row has ended; one missed check is only a hiccup.
const GONE_AFTER = 3

export const newId = () => Math.random().toString(36).slice(2, 10)
export const isSplit = (n: Node): n is Split => 'split' in n
export const spaceKey = (machine: string, path: string) => `${machine}\t${path}`
export const placeOfSpace = (key: string) => {
  const [machine, ...rest] = key.split('\t')
  return machine && rest.length && rest.join('\t') ? { machine, path: rest.join('\t') } : null
}
export const sessionSpace = (s: Session) => spaceKey(s.machine, s.path || s.cwd || s.folder || '')

// One layout holds every tab, or each folder has its own as in Orca.
export type Mode = 'shared' | 'folder'
export const SHARED = '*'
const MODE = 'yardbell.ui.workspaceMode'
export const MODE_EVENT = 'yardbell-workspace-mode'
export function workspaceMode(): Mode {
  try {
    return localStorage.getItem(MODE) === 'folder' ? 'folder' : 'shared'
  } catch {
    return 'shared'
  }
}
export function setWorkspaceMode(mode: Mode) {
  try {
    localStorage.setItem(MODE, mode)
  } catch {}
  window.dispatchEvent(new Event(MODE_EVENT))
}
const homeOf = (s: Session) => (workspaceMode() === 'shared' ? SHARED : sessionSpace(s))

const sameFolder = (a: string, b: string) => a.replace(/\/$/, '') === b.replace(/\/$/, '')

// The folder a tab works in, for the right panel when one layout holds tabs from many folders.
export function placeOfItem(i: Item | null, state: YardbellState | null) {
  if (!i) return null
  if (i.kind === 'session') {
    const s = state?.sessions.find((x) => keyOf(x) === i.key)
    const path = s ? s.path || s.cwd || '' : ''
    return s && path ? { machine: s.machine, path } : null
  }
  if ((i.kind === 'file' || i.kind === 'diff') && i.machine && i.root) return { machine: i.machine, path: i.root }
  return null
}

export function groups(node: Node, out: Group[] = []): Group[] {
  if (isSplit(node)) {
    groups(node.a, out)
    groups(node.b, out)
  } else out.push(node)
  return out
}

function parentOf(node: Node, target: Node, parent: Split | null = null): Split | null | undefined {
  if (node === target) return parent
  if (!isSplit(node)) return undefined
  const left = parentOf(node.a, target, node)
  return left !== undefined ? left : parentOf(node.b, target, node)
}

const blankGroup = (): Group => ({ group: newId(), items: [], active: null })
const blankSpace = (): Space => {
  const g = blankGroup()
  return { root: g, focus: g.group }
}

export function load(): Layouts {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || 'null')
    if (raw && raw.spaces && typeof raw.spaces === 'object') return { spaces: raw.spaces, current: raw.current || '', hidden: raw.hidden || [] }
  } catch {}
  return { spaces: {}, current: '', hidden: [] }
}

export function save(l: Layouts) {
  try {
    localStorage.setItem(STORE, JSON.stringify(l))
  } catch {}
}

const clone = (l: Layouts): Layouts => structuredClone(l)

function spaceOf(l: Layouts, key = l.current): Space {
  if (!l.spaces[key]) l.spaces[key] = blankSpace()
  return l.spaces[key]
}

export const currentSpace = (l: Layouts): Space | null => l.spaces[l.current] ?? null
export const focusedGroup = (sp: Space) => groups(sp.root).find((g) => g.group === sp.focus) ?? groups(sp.root)[0]
export const activeItem = (g: Group) => g.items.find((i) => i.id === g.active) ?? null

export function findItem(l: Layouts, pred: (i: Item) => boolean): { space: string; group: Group; item: Item } | null {
  for (const [space, sp] of Object.entries(l.spaces))
    for (const group of groups(sp.root)) {
      const item = group.items.find(pred)
      if (item) return { space, group, item }
    }
  return null
}

export function title(s: Session): string {
  const folder =
    String(s.folder || '')
      .split('/')
      .pop() ||
    s.tmux ||
    ''
  return s.ticket && s.ticket !== '-' ? `${s.ticket} · ${folder}` : folder
}

export function itemName(i: Item, state: YardbellState | null): string {
  if (i.name) return i.name
  if (i.kind === 'session') {
    const s = state?.sessions.find((x) => keyOf(x) === i.key)
    const agent = s ? state?.agents.find((a) => a.name === s.agent)?.label || s.agent : ''
    const name = agent || i.key?.split('/').pop() || 'Session'
    if (!s) return name
    const machines = new Set([...(state?.machines || []).map((m) => m.name), ...(state?.sessions || []).map((x) => x.machine)])
    const folder = workspaceMode() === 'shared' ? s.branch || String(s.path || s.cwd || s.folder || '').split('/').filter(Boolean).pop() || '' : ''
    return [folder, name, machines.size > 1 ? s.machine : ''].filter(Boolean).join(' · ')
  }
  if (i.kind === 'file' || i.kind === 'diff') {
    const name =
      String(i.path || '')
        .split('/')
        .pop() || 'File'
    return i.kind === 'diff' ? `${name} (${i.staged ? 'staged' : 'diff'})` : name
  }
  if (i.kind === 'browser') {
    try {
      return i.url ? new URL(i.url).host : 'Browser'
    } catch {
      return 'Browser'
    }
  }
  return 'Dispatch'
}

export function itemStatus(i: Item, state: YardbellState | null): Status {
  if (i.kind !== 'session') return ''
  const s = state?.sessions.find((x) => keyOf(x) === i.key)
  return s ? statusOf(s) : ''
}

export function spaceStatus(sp: Space, state: YardbellState | null): Status {
  return worst(groups(sp.root).flatMap((g) => g.items.map((i) => itemStatus(i, state))))
}

// A group left with no tabs goes, and its neighbour takes its room; the last group of a space stays.
function dropEmpty(sp: Space, g: Group) {
  if (g.items.length || !isSplit(sp.root)) return
  const parent = parentOf(sp.root, g)
  if (!parent) return
  const other = parent.a === g ? parent.b : parent.a
  const grand = parentOf(sp.root, parent)
  if (!grand) sp.root = other
  else if (grand.a === parent) grand.a = other
  else grand.b = other
  if (sp.focus === g.group) sp.focus = groups(other)[0].group
}

function removeItem(l: Layouts, itemId: string): Item | null {
  for (const sp of Object.values(l.spaces))
    for (const g of groups(sp.root)) {
      const at = g.items.findIndex((i) => i.id === itemId)
      if (at < 0) continue
      const [item] = g.items.splice(at, 1)
      if (g.active === itemId) g.active = g.items[Math.min(at, g.items.length - 1)]?.id ?? null
      dropEmpty(sp, g)
      return item
    }
  return null
}

// Moves tabs to where the mode says they belong: all into the one layout, or each back to its folder.
function regroup(l: Layouts, state: YardbellState) {
  if (workspaceMode() === 'shared') {
    const others = Object.keys(l.spaces).filter((k) => k !== SHARED)
    if (!others.length && l.current === SHARED) return
    const target = focusedGroup(spaceOf(l, SHARED))
    for (const k of others) {
      for (const g of groups(l.spaces[k].root)) target.items.push(...g.items)
      delete l.spaces[k]
    }
    if (!target.active) target.active = target.items[0]?.id ?? null
    l.current = SHARED
    return
  }
  const shared = l.spaces[SHARED]
  if (!shared) return
  const leftovers: Item[] = []
  for (const g of groups(shared.root))
    for (const item of g.items) {
      const place = placeOfItem(item, state)
      if (!place) {
        leftovers.push(item)
        continue
      }
      const g2 = focusedGroup(spaceOf(l, spaceKey(place.machine, place.path)))
      g2.items.push(item)
      if (!g2.active) g2.active = item.id
    }
  delete l.spaces[SHARED]
  const home = Object.keys(l.spaces)[0]
  if (leftovers.length) {
    const g = focusedGroup(spaceOf(l, home || SHARED))
    g.items.push(...leftovers)
    if (!g.active) g.active = leftovers[0].id
  }
  if (l.current === SHARED || !l.spaces[l.current]) l.current = home || Object.keys(l.spaces)[0] || ''
}

// In one layout, a folder is shown by its tab; with a layout per folder, by that layout.
export function showFolder(prev: Layouts, machine: string, path: string, state: YardbellState | null): Layouts {
  if (workspaceMode() === 'folder') return showSpace(prev, spaceKey(machine, path))
  const found = findItem(prev, (i) => {
    const p = placeOfItem(i, state)
    return Boolean(p && p.machine === machine && sameFolder(p.path, path))
  })
  if (!found) return prev
  const l = clone(prev)
  const again = findItem(l, (i) => i.id === found.item.id)!
  again.group.active = again.item.id
  l.spaces[again.space].focus = again.group.group
  return { ...l, current: again.space }
}

// Every running session has a tab in its worktree's layout, unless its tab was closed while it kept running.
export function sync(prev: Layouts, state: YardbellState, missing: Map<string, number>): Layouts {
  const l = clone(prev)
  regroup(l, state)
  const live = (state.sessions || []).filter((s) => s.tmux && (s.attachable || s.stale))
  const known = new Set(live.map(keyOf))
  for (const sp of Object.values(l.spaces))
    for (const g of groups(sp.root))
      for (const item of [...g.items]) {
        if (item.kind !== 'session' || !item.key) continue
        if (known.has(item.key)) {
          missing.delete(item.key)
          continue
        }
        const n = (missing.get(item.key) || 0) + 1
        missing.set(item.key, n)
        if (n < GONE_AFTER) continue
        missing.delete(item.key)
        removeItem(l, item.id)
      }
  l.hidden = l.hidden.filter((k) => known.has(k))
  for (const s of live) {
    const key = keyOf(s)
    if (s.stale || l.hidden.includes(key) || findItem(l, (i) => i.key === key)) continue
    const sp = spaceOf(l, homeOf(s))
    const g = focusedGroup(sp)
    const item: Item = { id: newId(), kind: 'session', key }
    g.items.push(item)
    if (!g.active) g.active = item.id
  }
  if (!l.current || !l.spaces[l.current]) l.current = live[0] ? homeOf(live[0]) : Object.keys(l.spaces)[0] || ''
  return l
}

export function showSpace(prev: Layouts, key: string): Layouts {
  if (prev.current === key && prev.spaces[key]) return prev
  const l = clone(prev)
  spaceOf(l, key)
  return { ...l, current: key }
}

export function focusGroup(prev: Layouts, group: string): Layouts {
  const sp = currentSpace(prev)
  if (!sp || sp.focus === group) return prev
  const l = clone(prev)
  spaceOf(l).focus = group
  return l
}

export function activate(prev: Layouts, group: string, itemId: string): Layouts {
  const l = clone(prev)
  const sp = spaceOf(l)
  const g = groups(sp.root).find((x) => x.group === group)
  if (!g) return prev
  g.active = itemId
  sp.focus = group
  return l
}

function addItem(l: Layouts, item: Item, group?: string): Layouts {
  const sp = spaceOf(l)
  const g = (group && groups(sp.root).find((x) => x.group === group)) || focusedGroup(sp)
  g.items.push(item)
  g.active = item.id
  sp.focus = g.group
  return l
}

// Opens a session where its tab already is, or puts it in the given group of the space you are in.
export function openSession(prev: Layouts, key: string, state: YardbellState | null, group?: string): Layouts {
  const l = clone(prev)
  l.hidden = l.hidden.filter((k) => k !== key)
  const found = findItem(l, (i) => i.key === key)
  if (found && !group) {
    found.group.active = found.item.id
    l.spaces[found.space].focus = found.group.group
    return { ...l, current: found.space }
  }
  if (found) removeItem(l, found.item.id)
  const s = state?.sessions.find((x) => keyOf(x) === key)
  if (!group && s) l.current = homeOf(s)
  return addItem(l, { id: newId(), kind: 'session', key }, group)
}

export function openItem(prev: Layouts, item: Omit<Item, 'id'>, group?: string): Layouts {
  const l = clone(prev)
  if (item.kind === 'file' || item.kind === 'diff') {
    const same = findItem(
      l,
      (i) => i.kind === item.kind && i.machine === item.machine && i.root === item.root && i.path === item.path && Boolean(i.staged) === Boolean(item.staged)
    )
    if (same) {
      same.group.active = same.item.id
      l.spaces[same.space].focus = same.group.group
      return { ...l, current: same.space }
    }
  }
  return addItem(l, { id: newId(), ...item }, group)
}

export function updateItem(prev: Layouts, itemId: string, patch: Partial<Item>): Layouts {
  const l = clone(prev)
  const found = findItem(l, (i) => i.id === itemId)
  if (!found) return prev
  Object.assign(found.item, patch)
  return l
}

export function closeItem(prev: Layouts, itemId: string): Layouts {
  const l = clone(prev)
  const item = removeItem(l, itemId)
  if (item?.key) l.hidden.push(item.key)
  return l
}

export function closeOthers(prev: Layouts, group: string, keep: string): Layouts {
  const l = clone(prev)
  const g = groups(spaceOf(l).root).find((x) => x.group === group)
  if (!g) return prev
  for (const i of g.items) if (i.id !== keep && i.key) l.hidden.push(i.key)
  g.items = g.items.filter((i) => i.id === keep)
  g.active = keep
  return l
}

function besides(sp: Space, target: Group, moving: Group, side: Side) {
  const dir = side === 'right' || side === 'left' ? 'row' : 'col'
  const first = side === 'left' || side === 'up'
  const replacement: Split = { split: dir, ratio: 0.5, a: first ? moving : target, b: first ? target : moving }
  const parent = parentOf(sp.root, target)
  if (!parent) sp.root = replacement
  else if (parent.a === target) parent.a = replacement
  else parent.b = replacement
}

// An empty group beside the given one, which can then take anything.
export function splitGroup(prev: Layouts, group: string, side: Side): Layouts {
  const l = clone(prev)
  const sp = spaceOf(l)
  const target = groups(sp.root).find((g) => g.group === group)
  if (!target) return prev
  const fresh = blankGroup()
  besides(sp, target, fresh, side)
  sp.focus = fresh.group
  return l
}

function place(sp: Space, item: Item, toGroup: string, side: Side | 'center', index?: number) {
  const target = groups(sp.root).find((g) => g.group === toGroup) ?? focusedGroup(sp)
  if (side === 'center') {
    target.items.splice(index ?? target.items.length, 0, item)
    target.active = item.id
    sp.focus = target.group
    return
  }
  const fresh: Group = { group: newId(), items: [item], active: item.id }
  besides(sp, target, fresh, side)
  sp.focus = fresh.group
}

// Dragging a tab: onto a strip moves it into that group, onto a pane's edge makes a new group there.
export function moveItem(prev: Layouts, itemId: string, toGroup: string, side: Side | 'center', index?: number): Layouts {
  const l = clone(prev)
  const sp = spaceOf(l)
  const fromGroup = groups(sp.root).find((g) => g.items.some((i) => i.id === itemId))
  const item = fromGroup?.items.find((i) => i.id === itemId)
  if (!fromGroup || !item) return prev
  const target = groups(sp.root).find((g) => g.group === toGroup)
  if (!target || (side !== 'center' && target === fromGroup && fromGroup.items.length === 1)) return prev
  const at = fromGroup.items.indexOf(item)
  fromGroup.items.splice(at, 1)
  if (fromGroup.active === itemId) fromGroup.active = fromGroup.items[Math.min(at, fromGroup.items.length - 1)]?.id ?? null
  const slot = side === 'center' && target === fromGroup && index !== undefined && index > at ? index - 1 : index
  place(sp, item, toGroup, side, slot)
  dropEmpty(sp, fromGroup)
  return l
}

// A session dragged in from the sidebar comes along with its tab, wherever that tab was.
export function dockSession(prev: Layouts, key: string, toGroup: string, side: Side | 'center'): Layouts {
  const found = findItem(prev, (i) => i.key === key)
  if (found && found.space === prev.current) return moveItem(prev, found.item.id, toGroup, side)
  const l = clone(prev)
  if (found) removeItem(l, found.item.id)
  l.hidden = l.hidden.filter((k) => k !== key)
  place(spaceOf(l), { id: newId(), kind: 'session', key }, toGroup, side)
  return l
}

// Undoing a split: the pane goes and its tabs join the pane beside it, so nothing closes.
export function closeGroup(prev: Layouts, group: string): Layouts {
  const l = clone(prev)
  const sp = spaceOf(l)
  const g = groups(sp.root).find((x) => x.group === group)
  const parent = g ? parentOf(sp.root, g) : null
  if (!g || !parent) return prev
  const neighbour = groups(parent.a === g ? parent.b : parent.a)[0]
  neighbour.items.push(...g.items)
  if (g.active) neighbour.active = g.active
  g.items = []
  g.active = null
  dropEmpty(sp, g)
  sp.focus = neighbour.group
  return l
}

export function setRatio(prev: Layouts, path: number[], ratio: number): Layouts {
  const l = clone(prev)
  let node = spaceOf(l).root
  for (const step of path) {
    if (!isSplit(node)) return prev
    node = step === 0 ? node.a : node.b
  }
  if (!isSplit(node)) return prev
  node.ratio = Math.min(0.9, Math.max(0.1, ratio))
  return l
}
